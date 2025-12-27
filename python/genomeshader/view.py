import os
import re
import hashlib
import threading
import socket
from typing import Union, List, Optional
from pathlib import Path
import importlib.resources
from http.server import HTTPServer, SimpleHTTPRequestHandler

import requests
import requests_cache
import polars as pl

from IPython.display import display, HTML
import json
import base64

import genomeshader.genomeshader as gs
from . import staging


class GenomeShader:
    def __init__(
        self,
        genome_build: str = 'hg38',
        gcs_session_dir: str = None,
    ):
        if gcs_session_dir is None:
            if "GOOGLE_BUCKET" in os.environ:
                bucket = os.environ["GOOGLE_BUCKET"]
                gcs_session_dir = f"{bucket}/genomeshader"
            else:
                raise ValueError(
                    "Cannot determine where to store visualization data. "
                    "GOOGLE_BUCKET is not set in environment variables "
                    "and gcs_session_dir is not specified."
                )

        self._validate_gcs_session_dir(gcs_session_dir)
        self.gcs_session_dir = gcs_session_dir

        self._validate_genome_build(genome_build)
        self.genome_build = genome_build

        requests_cache.install_cache('gs_rest_cache')

        self._session = gs._init()
        
        # Localhost HTTP server for serving staged files
        self._localhost_server: Optional[HTTPServer] = None
        self._localhost_port: Optional[int] = None
        self._localhost_thread: Optional[threading.Thread] = None

    def _validate_gcs_session_dir(self, gcs_session_dir: str):
        gcs_pattern = re.compile(
            r"^gs://[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]/"  # bucket
            r"([^/]+/)*"  # folders (optional)
            r"[^/]*$"  # file (optional)
        )

        if not gcs_pattern.match(gcs_session_dir):
            raise ValueError("Invalid GCS path")

    def _validate_genome_build(self, genome_build: str):
        response = requests.get("https://api.genome.ucsc.edu/list/ucscGenomes")
        if response.status_code == 200:
            ucsc_genomes = response.json().get('ucscGenomes', {})
            if genome_build not in ucsc_genomes:
                raise ValueError(f"The genome build '{genome_build}' is not available from UCSC.")
        else:
            raise ConnectionError("Failed to retrieve genome builds from UCSC REST API.")

    def __str__(self):
        return (
            f"genomeshader:\n"
            f" - genome_build: {self.genome_build}\n"
            f" - gcs_session_dir: {self.gcs_session_dir}\n"
        )

    def _load_template_html(self) -> str:
        """
        Load the template.html file from the package or fallback to relative path.
        
        Returns:
            str: The template HTML content as a string
        """
        # Try to load from package resources first (when installed via pip)
        try:
            template_path = importlib.resources.files("genomeshader").joinpath("html", "template.html")
            if template_path.is_file():
                return template_path.read_text(encoding='utf-8')
        except (AttributeError, FileNotFoundError, TypeError):
            pass
        
        # Fallback 1: Try relative path from this file (when installed via pip, html is in package)
        try:
            template_path = os.path.join(
                os.path.dirname(__file__), 'html', 'template.html'
            )
            if os.path.exists(template_path):
                with open(template_path, 'r', encoding='utf-8') as f:
                    return f.read()
        except (FileNotFoundError, OSError):
            pass
        
        # Fallback 2: Try relative path from project root (for development)
        template_path = os.path.join(
            os.path.dirname(__file__), '..', '..', 'html', 'template.html'
        )
        with open(template_path, 'r', encoding='utf-8') as f:
            return f.read()

    def session_name(self):
        """
        This function returns the name of the current session.

        Returns:
            str: The name of the current session.
        """
        return self.session_name

    def session_dir(self):
        """
        This function returns the GCS directory of the current session.

        Returns:
            str: The GCS directory of the current session.
        """
        return self.gcs_session_dir

    def attach_reads(
        self,
        gcs_paths: Union[str, List[str]],
        cohort: str = "all",
    ):
        """
        This function attaches reads from the provided GCS paths to the
        current session. The GCS paths can be a single string or a list.
        Each GCS path can be a direct path to a .bam or .cram file, or a
        directory containing .bam and/or .cram files. The genome build
        parameter specifies the reference genome build to use.

        Args:
            gcs_paths (Union[str, List[str]]): The GCS paths to attach reads.
            cohort (str, optional): An optional cohort label for the dataset.
                Defaults to 'all'.
        """
        if isinstance(gcs_paths, str):
            gcs_paths = [gcs_paths]  # Convert single string to list

        for gcs_path in gcs_paths:
            if gcs_path.endswith(".bam") or gcs_path.endswith(".cram"):
                self._session.attach_reads([gcs_path], cohort)
            else:
                bams = gs._gcs_list_files_of_type(gcs_path, ".bam")
                crams = gs._gcs_list_files_of_type(gcs_path, ".cram")

                self._session.attach_reads(bams, cohort)
                self._session.attach_reads(crams, cohort)

    def attach_loci(self, loci: Union[str, List[str]]):
        """
        Attaches loci to the current session from the provided list.
        The loci can be a single string or a list of strings.

        Args:
            loci (Union[str, List[str]]): Loci to be attached.
        """
        if isinstance(loci, str):
            self._session.attach_loci([loci])
        else:
            self._session.attach_loci(loci)

    def attach_variants(
        self,
        variant_files: Union[str, List[str]],
    ):
        """
        Attaches variant files (BCF/VCF) to the current session.
        The variant files can be a single string or a list of strings.
        Each path can be a direct path to a .bcf, .vcf, or .vcf.gz file,
        or a directory containing variant files.

        Args:
            variant_files (Union[str, List[str]]): The paths to variant files.
                Can be local file paths or GCS paths (gs://...).
                Supported formats: .bcf, .vcf, .vcf.gz
        """
        import genomeshader.genomeshader as gs
        
        if isinstance(variant_files, str):
            variant_files = [variant_files]  # Convert single string to list

        for variant_path in variant_files:
            if variant_path.endswith(".bcf") or variant_path.endswith(".vcf") or variant_path.endswith(".vcf.gz"):
                self._session.attach_variants([variant_path])
            else:
                # If it's a directory, list all variant files
                bcfs = gs._gcs_list_files_of_type(variant_path, ".bcf")
                vcfs = gs._gcs_list_files_of_type(variant_path, ".vcf")
                vcf_gzs = gs._gcs_list_files_of_type(variant_path, ".vcf.gz")

                self._session.attach_variants(bcfs)
                self._session.attach_variants(vcfs)
                self._session.attach_variants(vcf_gzs)

    def stage(self, use_cache: bool = True):
        """
        This function stages the current session. Staging fetches the specified
        loci from the BAM files and formats the results for fast visualization.

        Args:
            use_cache (bool, optional): If True, the function will attempt to
            use cached data if available. Defaults to True.
        """
        self._session.stage(use_cache)

    def get_locus(self, locus: str) -> pl.DataFrame:
        """
        This function retrieves the data for a staged locus from the
        current session.

        Args:
            locus (str): The locus to retrieve data for.

        Returns:
            pl.DataFrame: The data for the specified locus.
        """
        return self._session.get_locus(locus)


    def ideogram(self, contig: str) -> pl.DataFrame:
        # Define the API endpoint with the contig parameter
        api_endpoint = f"https://api.genome.ucsc.edu/getData/track?genome={self.genome_build};track=cytoBandIdeo"

        # Make a GET request to the API endpoint
        response = requests.get(api_endpoint)
        if response.status_code == 200:
            data = response.json()

            # Extract the 'contig' sub-key from the 'cytoBandIdeo' key
            ideo_data = data.get('cytoBandIdeo', {}).get(contig, [])
            ideo_df = pl.DataFrame(ideo_data)
        else:
            raise ConnectionError(f"Failed to retrieve data for contig '{contig}': {response.status_code}")

        # Define colors for different chromosome stains
        color_lookup = {
            "gneg": "#ffffff",
            "gpos25": "#c0c0c0",
            "gpos50": "#808080",
            "gpos75": "#404040",
            "gpos100": "#000000",
            "acen": "#660033",
            "gvar": "#660099",
            "stalk": "#6600cc",
        }

        # Map the gieStain values to their corresponding colors
        ideo_df = ideo_df.with_columns(
            pl.col("gieStain").alias("color").replace(color_lookup)
        )

        # Convert to list of dictionaries for JSON serialization
        return ideo_df.to_dicts()

    def genes(self, contig: str, start: int, end: int, track: str = "ncbiRefSeq") -> pl.DataFrame:
        # Define the API endpoint with the track, contig, start, end parameters
        api_endpoint = f"https://api.genome.ucsc.edu/getData/track?genome={self.genome_build};track={track};chrom={contig};start={start};end={end}"

        # Make a GET request to the API endpoint
        response = requests.get(api_endpoint)
        if response.status_code == 200:
            data = response.json()

            # Extract the 'contig' sub-key from the 'cytoBandIdeo' key
            gene_data = data.get('ncbiRefSeq', {})
            gene_df = pl.DataFrame(gene_data)
        else:
            raise ConnectionError(f"Failed to retrieve data from track {track} for locus '{contig}:{start}-{end}': {response.status_code}")

        return gene_df.write_json()

    def reference(self, contig: str, start: int, end: int, track: str = "ncbiRefSeq") -> pl.DataFrame:
        # Define the API endpoint with the track, contig, start, end parameters
        api_endpoint = f"https://api.genome.ucsc.edu/getData/sequence?genome={self.genome_build};track={track};chrom={contig};start={start};end={end}"

        # Make a GET request to the API endpoint
        response = requests.get(api_endpoint)
        if response.status_code == 200:
            data = response.json()

            # Extract the 'contig' sub-key from the 'cytoBandIdeo' key
            ref_data = data.get('dna', {})
            ref_df = pl.DataFrame(ref_data)
        else:
            raise ConnectionError(f"Failed to retrieve data from track {track} for locus '{contig}:{start}-{end}': {response.status_code}")

        return ref_df.write_json()

    def _start_localhost_server(self, serve_dir: Path) -> int:
        """
        Starts a localhost HTTP server to serve files from the given directory.
        
        Args:
            serve_dir: Directory to serve files from
            
        Returns:
            int: Port number the server is running on
        """
        if self._localhost_server is not None:
            # Server already running, return existing port
            return self._localhost_port
        
        # Find an available port
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
        sock.close()
        
        # Create a custom handler that serves from the specified directory with CORS headers
        class StagingHandler(SimpleHTTPRequestHandler):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, directory=str(serve_dir), **kwargs)
            
            def end_headers(self):
                # Add CORS headers to allow requests from Jupyter notebook
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
                self.send_header('Access-Control-Allow-Headers', 'Content-Type')
                super().end_headers()
            
            def do_OPTIONS(self):
                # Handle preflight requests
                self.send_response(200)
                self.end_headers()
            
            def log_message(self, format, *args):
                # Suppress server logs
                pass
        
        # Create and start server
        server = HTTPServer(('127.0.0.1', port), StagingHandler)
        
        def run_server():
            server.serve_forever()
        
        thread = threading.Thread(target=run_server, daemon=True)
        thread.start()
        
        self._localhost_server = server
        self._localhost_port = port
        self._localhost_thread = thread
        
        return port
    
    def _get_manifest_url(self, manifest_path: Path) -> str:
        """
        Gets the URL for accessing the manifest file.
        Uses localhost HTTP server since Jupyter /files/ route doesn't work reliably.
        
        Args:
            manifest_path: Absolute path to the manifest file
            
        Returns:
            str: URL to access the manifest file
        """
        # Use localhost server approach since /files/ route has 403 issues
        serve_dir = manifest_path.parent
        port = self._start_localhost_server(serve_dir)
        
        # Get relative path from serve directory
        rel_path = manifest_path.relative_to(serve_dir)
        rel_path_str = rel_path.as_posix()
        
        return f"http://127.0.0.1:{port}/{rel_path_str}"

    def render(
        self,
        locus_or_dataframe: Union[str, pl.DataFrame],
    ) -> str:
        """
        Visualizes genomic data by rendering a graphical representation of a genomic locus.

        Parameters:
            locus_or_dataframe (Union[str, pl.DataFrame]): The genomic locus to visualize, which can be specified as either:
                - A string representing the locus in the format 'chromosome:start-stop' (e.g., 'chr1:1000000-2000000').
                - A Polars DataFrame containing genomic data, which can be obtained from the `get_locus()` method or created by the user.
            horizontal (bool, optional): If set to True, the visualization will be rendered horizontally. Defaults to False.
            group_by (str, optional): The name of the column to group data by in the visualization. Defaults to None.

        Returns:
            str: an html object that can be displayed (via IPython display) or saved to disk.
        """

        if isinstance(locus_or_dataframe, str):
            samples_df = self.get_locus(locus_or_dataframe)
        elif isinstance(locus_or_dataframe, pl.DataFrame):
            samples_df = locus_or_dataframe.clone()
        else:
            raise ValueError(
                "locus_or_dataframe must be a locus string or a Polars DataFrame."
            )

        ref_chr = samples_df["reference_contig"].min()
        ref_start = samples_df["reference_start"].min()
        ref_end = samples_df["reference_end"].max()

        # Compute stable run_id from region + genome_build
        region_str = f"{ref_chr}:{ref_start}-{ref_end}"
        hash_input = f"{region_str}:{self.genome_build}"
        run_id = hashlib.sha256(hash_input.encode('utf-8')).hexdigest()[:8]

        # Create run directory structure
        try:
            run_dir = staging.make_run_dir(run_id)
            tracks_dir = run_dir / "tracks"
        except Exception as e:
            raise RuntimeError(f"Failed to create run directory: {e}")

        # Write track.json file
        try:
            if len(samples_df) > 0:
                # Convert DataFrame to list of dicts
                track_data = samples_df.to_dicts()
            else:
                # Use dummy data if dataframe is empty
                track_data = [{"x": 1, "label": "a"}, {"x": 2, "label": "b"}]
            
            track_path = tracks_dir / "track.json"
            staging.write_json(track_path, track_data)
        except Exception as e:
            raise RuntimeError(f"Failed to write track file: {e}")

        # Write manifest.json
        try:
            manifest_data = {
                "version": 1,
                "run_id": run_id,
                "region": {
                    "contig": str(ref_chr),
                    "start": int(ref_start),
                    "end": int(ref_end)
                },
                "tracks": {
                    "demo": {
                        "url": "tracks/track.json",
                        "format": "json"
                    }
                }
            }
            manifest_path = run_dir / "manifest.json"
            staging.write_json(manifest_path, manifest_data)
        except Exception as e:
            raise RuntimeError(f"Failed to write manifest file: {e}")

        # Load cytoband data for the chromosome
        ideogram_data = self.ideogram(ref_chr)

        # Load template HTML
        template_html = self._load_template_html()

        # Get manifest URL using localhost server
        manifest_url = self._get_manifest_url(manifest_path)

        # Build config dict first, then JSON-encode it
        config = {
            'region': f"{ref_chr}:{ref_start}-{ref_end}",
            'genome_build': self.genome_build,
            'ideogram_data': ideogram_data,
        }

        # Get Jupyter origin for constructing absolute URLs
        # Try to get it from environment or use a default
        jupyter_origin = os.environ.get("JUPYTER_ORIGIN", "")
        if not jupyter_origin:
            # Try to construct from JUPYTERHUB_SERVICE_PREFIX if available
            prefix = os.environ.get("JUPYTERHUB_SERVICE_PREFIX", "")
            if prefix:
                # Extract origin from prefix (e.g., "/user/username/" -> "")
                # We'll let JavaScript figure it out from window.opener
                jupyter_origin = ""
            else:
                # Default to localhost:8888 (common Jupyter port)
                jupyter_origin = "http://localhost:8888"
        
        # Build bootstrap snippet with manifest URL and config
        # Data will be fetched lazily via postMessage (not embedded)
        bootstrap = f"""<script>
window.GENOMESHADER_MANIFEST_URL = {json.dumps(manifest_url)};
window.GENOMESHADER_CONFIG = {json.dumps(config)};
window.GENOMESHADER_JUPYTER_ORIGIN = {json.dumps(jupyter_origin)};
</script>"""

        # Inject bootstrap into template
        final_html = template_html.replace("<!--__GENOMESHADER_BOOTSTRAP__-->", bootstrap)

        # Create popup script using blob URL
        # Base64 encode the HTML to avoid Jupyter trying to render it as HTML
        html_encoded = base64.b64encode(final_html.encode('utf-8')).decode('utf-8')
        
        html_script = f"""
<script type="text/javascript">
(function() {{
  try {{
    const width = 0.8 * window.screen.width;
    const height = 0.65 * window.screen.height;
    
    // Decode base64 HTML to avoid Jupyter rendering issues
    const htmlBase64 = {json.dumps(html_encoded)};
    // atob() returns binary string, need to decode UTF-8 properly
    const binaryString = atob(htmlBase64);
    // Convert binary string to Uint8Array, then decode as UTF-8
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {{
      bytes[i] = binaryString.charCodeAt(i);
    }}
    const html = new TextDecoder('utf-8').decode(bytes);
    
    const blob = new Blob([html], {{ type: "text/html;charset=utf-8" }});
    const url = URL.createObjectURL(blob);
    
    // Store URL in a variable that won't be garbage collected
    window._genomeshaderBlobUrl = url;
    
    const win = window.open(url, "genomeshader", 
      "width=" + width + ",height=" + height + ",scrollbars=no,menubar=no,toolbar=no,status=no");
    
    if (!win) {{
      console.error("Failed to open popup window - may be blocked by browser");
      alert("Popup window was blocked. Please allow popups for this site.");
      URL.revokeObjectURL(url);
      return;
    }}
    
    // Set up postMessage handler for lazy loading data requests
    // The popup window will request data via postMessage, and we'll fetch it from localhost
    window.addEventListener('message', function(event) {{
      // Only accept messages from the popup window we just opened
      if (event.source !== win) {{
        return;
      }}
      
      const data = event.data;
      
      // Handle data fetch requests from popup
      if (data && data.type === 'genomeshader_fetch') {{
        const url = data.url;
        console.log('Genomeshader: Fetching data from popup request:', url);
        
        // Fetch the data from localhost (we can do this from Jupyter notebook context)
        fetch(url)
          .then(response => {{
            if (!response.ok) {{
              throw new Error(`HTTP ${{response.status}}: ${{response.statusText}}`);
            }}
            return response.json();
          }})
          .then(jsonData => {{
            // Send data back to popup
            win.postMessage({{
              type: 'genomeshader_fetch_response',
              requestId: data.requestId,
              url: url,
              data: jsonData,
              success: true
            }}, '*');
            console.log('Genomeshader: Sent data to popup for:', url);
          }})
          .catch(error => {{
            // Send error back to popup
            win.postMessage({{
              type: 'genomeshader_fetch_response',
              requestId: data.requestId,
              url: url,
              error: error.message,
              success: false
            }}, '*');
            console.error('Genomeshader: Error fetching data:', error);
          }});
      }}
    }});
    
    // Wait for window to load before setting up cleanup
    win.addEventListener('load', function() {{
      console.log("Genomeshader window loaded successfully");
      // Notify popup that we're ready to handle fetch requests
      win.postMessage({{ type: 'genomeshader_ready' }}, '*');
    }});
    
    // Keep the blob URL alive - don't revoke immediately
    // The URL will be revoked when the window is closed
    win.addEventListener('beforeunload', function() {{
      URL.revokeObjectURL(url);
      delete window._genomeshaderBlobUrl;
    }});
    
    // Fallback: revoke after 10 minutes if window is still open (cleanup)
    setTimeout(function() {{
      try {{
        if (win.closed) {{
          URL.revokeObjectURL(url);
          delete window._genomeshaderBlobUrl;
        }}
      }} catch(e) {{
        // Window might be from different origin, ignore
      }}
    }}, 600000);
    
    // Focus the window to bring it to front
    setTimeout(function() {{
      try {{
        win.focus();
      }} catch(e) {{
        // May fail if window is from different origin
      }}
    }}, 100);
    
  }} catch(error) {{
    console.error("Error opening genomeshader window:", error);
    alert("Error opening visualization: " + error.message);
  }}
}})();
</script>
        """

        return html_script


    def show(
        self,
        locus_or_dataframe: Union[str, pl.DataFrame],
    ):
        html_script = self.render(locus_or_dataframe)

        # Display the HTML and JavaScript
        display(HTML(html_script))


    def save(
        self,
        locus_or_dataframe: Union[str, pl.DataFrame],
        filename: str
    ):
        html_script = self.render(locus_or_dataframe)

        with open(filename, 'w') as file:
            file.write(html_script)

        print(f'Saved to "{filename}" ({self._pretty_filesize(filename)}).')

    def _pretty_filesize(self, filename: str) -> str:
        # Get the file size in bytes
        file_size = os.path.getsize(filename)
        
        # Define the unit thresholds and corresponding labels
        thresholds = [(1024 ** 3, 'Gb'), (1024 ** 2, 'Mb'), (1024, 'kb')]
        
        # Find the appropriate unit and value
        for threshold, unit in thresholds:
            if file_size >= threshold:
                value = file_size / threshold
                break
        else:
            unit = 'bytes'
            value = file_size
        
        # Format the file size with the unit and return
        pretty_size = f"{value:.2f} {unit}"

        return pretty_size

    def reset(self):
        self._session.reset()

    def print(self):
        self._session.print()


def init(gcs_session_dir: str = None) -> GenomeShader:
    session = GenomeShader(
        gcs_session_dir=gcs_session_dir,
    )

    return session


def version():
    return gs._version()

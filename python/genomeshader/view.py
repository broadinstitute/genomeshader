import os
import re
from typing import Union, List
import importlib.resources

import requests
import requests_cache
import polars as pl

from IPython.display import display, HTML
import json
import base64

import genomeshader.genomeshader as gs


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
        # Try to load from package resources first
        try:
            # Try relative to genomeshader package
            template_path = importlib.resources.files("genomeshader").joinpath("../html/template.html")
            if template_path.is_file():
                return template_path.read_text(encoding='utf-8')
        except (AttributeError, FileNotFoundError, TypeError):
            pass
        
        # Fallback to relative path from this file
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

        # Load cytoband data for the chromosome
        ideogram_data = self.ideogram(ref_chr)

        # Load template HTML
        template_html = self._load_template_html()

        # Construct manifest URL (placeholder for future lazy loading)
        manifest_url = f"{self.gcs_session_dir}/manifest.json"

        # Build config dict first, then JSON-encode it
        config = {
            'region': f"{ref_chr}:{ref_start}-{ref_end}",
            'genome_build': self.genome_build,
            'ideogram_data': ideogram_data,
        }

        # Build bootstrap snippet with manifest URL and config
        bootstrap = f"""<script>
window.GENOMESHADER_MANIFEST_URL = {json.dumps(manifest_url)};
window.GENOMESHADER_CONFIG = {json.dumps(config)};
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
    
    // Wait for window to load before setting up cleanup
    win.addEventListener('load', function() {{
      console.log("Genomeshader window loaded successfully");
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

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

    def genes(self, contig: str, start: int, end: int, track: str = "ncbiRefSeq") -> List[dict]:
        # Define the API endpoint with the track, contig, start, end parameters
        api_endpoint = f"https://api.genome.ucsc.edu/getData/track?genome={self.genome_build};track={track};chrom={contig};start={start};end={end}"

        # Make a GET request to the API endpoint
        response = requests.get(api_endpoint)
        if response.status_code == 200:
            data = response.json()

            # Extract the gene data from the response
            # UCSC API typically returns: {track_name: {contig: [{gene1}, {gene2}, ...]}}
            # But can also be: {track_name: [{gene1}, {gene2}, ...]} for some endpoints
            gene_data = None
            
            # Debug: print the top-level keys to understand structure
            if not data:
                print(f"Warning: Empty response from UCSC API for {contig}:{start}-{end}")
                gene_data = []
            else:
                # Try to get data by track name first
                if track in data:
                    track_data = data[track]
                    # If nested by chromosome
                    if isinstance(track_data, dict) and contig in track_data:
                        gene_data = track_data[contig]
                    # If flat array
                    elif isinstance(track_data, list):
                        gene_data = track_data
                
                # Try alternative: 'ncbiRefSeq' key
                if not gene_data:
                    if 'ncbiRefSeq' in data:
                        alt_data = data['ncbiRefSeq']
                        if isinstance(alt_data, dict) and contig in alt_data:
                            gene_data = alt_data[contig]
                        elif isinstance(alt_data, list):
                            gene_data = alt_data
                
                # If still not found, check if data has any keys that might contain the track
                if not gene_data:
                    # Try to find any key that contains a list or dict with our contig
                    for key, value in data.items():
                        if isinstance(value, dict) and contig in value:
                            if isinstance(value[contig], list) and len(value[contig]) > 0:
                                # Check if it looks like gene data (has chromStart/chromEnd)
                                if isinstance(value[contig][0], dict) and 'chromStart' in value[contig][0]:
                                    gene_data = value[contig]
                                    break
                        elif isinstance(value, list) and len(value) > 0:
                            # Check if it looks like gene data
                            if isinstance(value[0], dict) and 'chromStart' in value[0]:
                                gene_data = value
                                break
                
            # Default to empty list if nothing found
            if gene_data is None:
                gene_data = []
        else:
            raise ConnectionError(f"Failed to retrieve data from track {track} for locus '{contig}:{start}-{end}': {response.status_code}")

        # Transform UCSC gene data to transcript format
        transcripts = []
        if not isinstance(gene_data, list):
            # If gene_data is not a list, return empty (shouldn't happen but be safe)
            return transcripts
            
        for gene in gene_data:
            try:
                # Extract basic fields - UCSC API uses txStart/txEnd for genePred tracks
                # But also support chromStart/chromEnd for other track types
                chrom_start = gene.get('txStart') or gene.get('chromStart', 0)
                chrom_end = gene.get('txEnd') or gene.get('chromEnd', 0)
                strand = gene.get('strand', '+')
                
                # Skip if we don't have valid coordinates
                if not chrom_start or not chrom_end:
                    continue
                
                # Get gene name - prefer name2 (gene symbol) over name (transcript ID)
                gene_name = gene.get('name2') or gene.get('name') or gene.get('geneName') or gene.get('transcriptName') or 'Unknown'
                
                # Parse exon information
                # UCSC genePred format uses exonStarts/exonEnds
                # Other formats might use blockStarts/blockSizes
                exons = []
                exon_count = gene.get('exonCount') or gene.get('blockCount', 0)
                
                if exon_count > 0:
                    # Try exonStarts/exonEnds format (genePred)
                    exon_starts_str = gene.get('exonStarts', '')
                    exon_ends_str = gene.get('exonEnds', '')
                    
                    if exon_starts_str and exon_ends_str:
                        try:
                            # Parse comma-separated values (may have trailing comma)
                            exon_starts = [int(x) for x in exon_starts_str.split(',') if x.strip()]
                            exon_ends = [int(x) for x in exon_ends_str.split(',') if x.strip()]
                            
                            # Create exon arrays: [start, end] pairs in 1-based coordinates
                            for i in range(min(len(exon_starts), len(exon_ends), exon_count)):
                                exon_start = exon_starts[i] + 1  # Convert to 1-based
                                exon_end = exon_ends[i]  # Already 1-based end
                                exons.append([exon_start, exon_end])
                        except (ValueError, IndexError):
                            # If parsing fails, try blockStarts/blockSizes format
                            pass
                    
                    # If exonStarts/exonEnds didn't work, try blockStarts/blockSizes
                    if not exons:
                        block_starts_str = str(gene.get('blockStarts', ''))
                        block_sizes_str = str(gene.get('blockSizes', ''))
                        
                        if block_starts_str and block_sizes_str:
                            try:
                                # Parse comma-separated values
                                block_starts = [int(x) for x in block_starts_str.split(',') if x.strip()]
                                block_sizes = [int(x) for x in block_sizes_str.split(',') if x.strip()]
                                
                                # Create exon arrays: [start, end] pairs in 1-based coordinates
                                for i in range(min(len(block_starts), len(block_sizes), exon_count)):
                                    exon_start = chrom_start + block_starts[i] + 1  # Convert to 1-based
                                    exon_end = exon_start + block_sizes[i] - 1
                                    exons.append([exon_start, exon_end])
                            except (ValueError, IndexError):
                                # If parsing fails, fall back to transcript boundaries
                                pass
                
                # If no exons found, use transcript boundaries
                if not exons:
                    exons = [[chrom_start + 1, chrom_end]]  # Convert to 1-based
                
                # Create transcript dict
                transcript = {
                    'name': str(gene_name),
                    'strand': strand,
                    'start': chrom_start + 1,  # Convert to 1-based
                    'end': chrom_end,
                    'exons': exons,
                }
                transcripts.append(transcript)
            except Exception as e:
                # Skip genes that fail to parse, but continue with others
                print(f"Warning: Failed to parse gene entry: {e}")
                continue
        
        # Sort transcripts by start position for lane assignment
        transcripts.sort(key=lambda t: t['start'])
        
        # Assign lanes to avoid overlaps (simple greedy algorithm)
        lanes = [[], [], []]  # Three lanes
        for transcript in transcripts:
            assigned = False
            for lane_idx in range(3):
                # Check if transcript overlaps with any existing transcript in this lane
                overlaps = False
                for existing in lanes[lane_idx]:
                    # Check if intervals overlap
                    if not (transcript['end'] < existing['start'] or transcript['start'] > existing['end']):
                        overlaps = True
                        break
                
                if not overlaps:
                    transcript['lane'] = lane_idx
                    lanes[lane_idx].append(transcript)
                    assigned = True
                    break
            
            # If no lane available, assign to lane 0 anyway (will overlap)
            if not assigned:
                transcript['lane'] = 0
                lanes[0].append(transcript)
        
        return transcripts

    def repeats(self, contig: str, start: int, end: int, track: str = "rmsk") -> List[dict]:
        """
        Fetches RepeatMasker repeat data from UCSC for a given genomic region.
        
        Args:
            contig (str): Chromosome/contig name (e.g., 'chr1')
            start (int): Start position (0-based)
            end (int): End position (0-based)
            track (str, optional): UCSC track name. Defaults to 'rmsk' (RepeatMasker).
        
        Returns:
            List[dict]: List of repeat intervals, each with 'start', 'end', and 'cls' fields.
        """
        # Define the API endpoint with the track, contig, start, end parameters
        api_endpoint = f"https://api.genome.ucsc.edu/getData/track?genome={self.genome_build};track={track};chrom={contig};start={start};end={end}"

        # Make a GET request to the API endpoint
        response = requests.get(api_endpoint)
        if response.status_code == 200:
            data = response.json()
            
            # Check for API errors in response
            if isinstance(data, dict) and 'error' in data:
                error_msg = data.get('error', 'Unknown error')
                print(f"Warning: UCSC API returned error for RepeatMasker track: {error_msg}")
                return []

            # Extract the repeat data from the response
            # UCSC API typically returns: {track_name: {contig: [{repeat1}, {repeat2}, ...]}}
            repeat_data = None
            
            if not data:
                print(f"Warning: Empty response from UCSC API for {contig}:{start}-{end}")
                repeat_data = []
            else:
                # Try to get data by track name first
                if track in data:
                    track_data = data[track]
                    # If nested by chromosome
                    if isinstance(track_data, dict) and contig in track_data:
                        repeat_data = track_data[contig]
                    # If flat array
                    elif isinstance(track_data, list):
                        repeat_data = track_data
                
                # Try alternative: 'rmsk' key
                if not repeat_data:
                    if 'rmsk' in data:
                        alt_data = data['rmsk']
                        if isinstance(alt_data, dict) and contig in alt_data:
                            repeat_data = alt_data[contig]
                        elif isinstance(alt_data, list):
                            repeat_data = alt_data
                
                # Try alternative track names that UCSC might use
                if not repeat_data:
                    for alt_track_name in ['repeatMasker', 'RepeatMasker', 'rmsk', 'repeat']:
                        if alt_track_name in data:
                            alt_data = data[alt_track_name]
                            if isinstance(alt_data, dict) and contig in alt_data:
                                repeat_data = alt_data[contig]
                                break
                            elif isinstance(alt_data, list):
                                repeat_data = alt_data
                                break
                
                # If still not found, check if data has any keys that might contain the track
                if not repeat_data:
                    # Try to find any key that contains a list or dict with our contig
                    for key, value in data.items():
                        if isinstance(value, dict) and contig in value:
                            if isinstance(value[contig], list) and len(value[contig]) > 0:
                                # Check if it looks like repeat data (has genoStart/genoEnd or chromStart/chromEnd)
                                first_item = value[contig][0]
                                if isinstance(first_item, dict) and ('genoStart' in first_item or 'chromStart' in first_item):
                                    repeat_data = value[contig]
                                    break
                        elif isinstance(value, list) and len(value) > 0:
                            # Check if it looks like repeat data
                            first_item = value[0]
                            if isinstance(first_item, dict) and ('genoStart' in first_item or 'chromStart' in first_item):
                                repeat_data = value
                                break
                
            # Default to empty list if nothing found
            if repeat_data is None:
                # Only print warning if we actually got data but couldn't parse it
                if data:
                    print(f"Warning: Could not find repeat data in UCSC API response for track '{track}'. Available keys: {list(data.keys())}")
                repeat_data = []
        else:
            # Try alternative track name if first attempt fails
            repeat_data = None
            if track == "rmsk":
                print(f"Warning: Track 'rmsk' returned status {response.status_code}, trying 'repeatMasker'...")
                alt_endpoint = f"https://api.genome.ucsc.edu/getData/track?genome={self.genome_build};track=repeatMasker;chrom={contig};start={start};end={end}"
                alt_response = requests.get(alt_endpoint)
                if alt_response.status_code == 200:
                    data = alt_response.json()
                    if isinstance(data, dict) and 'error' in data:
                        error_msg = data.get('error', 'Unknown error')
                        print(f"Warning: UCSC API returned error for RepeatMasker track: {error_msg}")
                        return []
                    if isinstance(data, dict) and 'repeatMasker' in data:
                        track_data = data['repeatMasker']
                        if isinstance(track_data, dict) and contig in track_data:
                            repeat_data = track_data[contig]
                        elif isinstance(track_data, list):
                            repeat_data = track_data
                    if not repeat_data:
                        return []
                else:
                    raise ConnectionError(f"Failed to retrieve data from RepeatMasker track for locus '{contig}:{start}-{end}': {response.status_code}")
            else:
                raise ConnectionError(f"Failed to retrieve data from track {track} for locus '{contig}:{start}-{end}': {response.status_code}")
            
            # If we got here from the else block and repeat_data is still None, return empty
            if repeat_data is None:
                return []

        # Transform UCSC repeat data to our format
        repeats = []
        if not isinstance(repeat_data, list):
            # If repeat_data is not a list, return empty (shouldn't happen but be safe)
            return repeats
            
        for repeat in repeat_data:
            try:
                # Extract basic fields - UCSC RepeatMasker API uses genoStart/genoEnd
                # (not chromStart/chromEnd like other tracks)
                chrom_start = repeat.get('genoStart') or repeat.get('chromStart', 0)
                chrom_end = repeat.get('genoEnd') or repeat.get('chromEnd', 0)
                
                # Skip if we don't have valid coordinates
                if not chrom_start or not chrom_end:
                    continue
                
                # Get repeat class/family
                # UCSC RepeatMasker tracks use 'repClass' for the main class (SINE, LINE, LTR, DNA, etc.)
                # and 'repFamily' for the specific family
                rep_class = repeat.get('repClass') or repeat.get('class') or repeat.get('type') or 'Unknown'
                
                # Create repeat dict with 1-based coordinates (matching genes format)
                repeat_dict = {
                    'start': chrom_start + 1,  # Convert to 1-based
                    'end': chrom_end,  # Already 1-based end
                    'cls': str(rep_class),  # Class as string
                }
                repeats.append(repeat_dict)
            except Exception as e:
                # Skip repeats that fail to parse, but continue with others
                print(f"Warning: Failed to parse repeat entry: {e}")
                continue
        
        # Sort repeats by start position
        repeats.sort(key=lambda r: r['start'])
        
        return repeats

    def reference(self, contig: str, start: int, end: int, track: str = "ncbiRefSeq") -> str:
        """
        Fetches reference sequence data from UCSC for a given genomic region.
        
        Args:
            contig (str): Chromosome/contig name (e.g., 'chr1')
            start (int): Start position (0-based)
            end (int): End position (0-based)
            track (str, optional): UCSC track name. Defaults to 'ncbiRefSeq'.
        
        Returns:
            str: DNA sequence string for the specified region.
        """
        # Define the API endpoint with the track, contig, start, end parameters
        api_endpoint = f"https://api.genome.ucsc.edu/getData/sequence?genome={self.genome_build};track={track};chrom={contig};start={start};end={end}"

        # Make a GET request to the API endpoint
        response = requests.get(api_endpoint)
        if response.status_code == 200:
            data = response.json()
            
            # Check for API errors in response
            if isinstance(data, dict) and 'error' in data:
                error_msg = data.get('error', 'Unknown error')
                print(f"Warning: UCSC API returned error for reference sequence: {error_msg}")
                return ""
            
            # Extract the sequence string from the 'dna' field
            # UCSC sequence API returns: {"dna": "ATCGATCG..."}
            sequence = data.get('dna', '')
            
            if not sequence:
                print(f"Warning: Empty sequence data from UCSC API for {contig}:{start}-{end}")
                return ""
            
            return sequence
        else:
            raise ConnectionError(f"Failed to retrieve reference sequence from track {track} for locus '{contig}:{start}-{end}': {response.status_code}")

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
        
        # Store the actual data bounds (where reads exist)
        # These may differ from the displayed region if user zooms/pans
        data_start = int(ref_start)
        data_end = int(ref_end)

        # Format region string with commas for thousands
        region_str_formatted = f"{ref_chr}:{ref_start:,}-{ref_end:,}"

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

        # Load gene/transcript data for the region
        try:
            transcripts_data = self.genes(ref_chr, ref_start, ref_end)
        except Exception as e:
            # If gene data retrieval fails, use empty list but don't crash
            print(f"Warning: Failed to load gene data: {e}")
            transcripts_data = []

        # Load RepeatMasker data for the region
        try:
            repeats_data = self.repeats(ref_chr, ref_start, ref_end)
        except Exception as e:
            # If repeat data retrieval fails, use empty list but don't crash
            print(f"Warning: Failed to load RepeatMasker data: {e}")
            repeats_data = []

        # Load reference sequence data for the region
        try:
            reference_sequence = self.reference(ref_chr, ref_start, ref_end)
        except Exception as e:
            # If reference data retrieval fails, use empty string but don't crash
            print(f"Warning: Failed to load reference sequence data: {e}")
            reference_sequence = ""

        # Load template HTML
        template_html = self._load_template_html()

        # Get manifest URL using localhost server
        manifest_url = self._get_manifest_url(manifest_path)

        # Build config dict first, then JSON-encode it
        config = {
            'hostMode': 'inline',  # Explicitly set inline mode for notebook rendering
            'region': f"{ref_chr}:{ref_start}-{ref_end}",
            'region_formatted': region_str_formatted,  # Formatted with commas for display
            'genome_build': self.genome_build,
            'ideogram_data': ideogram_data,
            'transcripts_data': transcripts_data,
            'repeats_data': repeats_data,
            'reference_data': reference_sequence,
            'data_bounds': {
                'start': data_start,
                'end': data_end,
            },
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
        
        # Build bootstrap snippet with manifest URL, config, and view ID
        # Data will be fetched lazily via postMessage (not embedded)
        bootstrap = f"""<script>
window.GENOMESHADER_MANIFEST_URL = {json.dumps(manifest_url)};
window.GENOMESHADER_CONFIG = {json.dumps(config)};
window.GENOMESHADER_JUPYTER_ORIGIN = {json.dumps(jupyter_origin)};
window.GENOMESHADER_VIEW_ID = {json.dumps(run_id)};
</script>"""

        # Inject bootstrap into template
        final_html = template_html.replace("<!--__GENOMESHADER_BOOTSTRAP__-->", bootstrap)

        # Extract styles and body content from template HTML for inline rendering
        # The template is a full HTML document, we need to extract styles and body content
        import re
        
        # Extract styles from <head>
        style_match = re.search(r'<style[^>]*>(.*?)</style>', final_html, re.DOTALL)
        styles = style_match.group(1) if style_match else ""
        
        # Extract body content
        body_match = re.search(r'<body[^>]*>(.*?)</body>', final_html, re.DOTALL)
        if body_match:
            body_content = body_match.group(1)
        else:
            # Fallback: if no body tag found, use entire template
            body_content = final_html

        # Generate inline HTML with container div, styles, and bootstrap script
        container_id = f"genomeshader-root-{run_id}"
        
        # Bootstrap script must run FIRST to set window variables before template scripts execute
        # The bootstrap is already injected into final_html, but we need to include it in inline output
        bootstrap_script = f"""
<script type="text/javascript">
// Bootstrap: Set window variables before template scripts run
window.GENOMESHADER_MANIFEST_URL = {json.dumps(manifest_url)};
window.GENOMESHADER_CONFIG = {json.dumps(config)};
window.GENOMESHADER_JUPYTER_ORIGIN = {json.dumps(jupyter_origin)};
window.GENOMESHADER_VIEW_ID = {json.dumps(run_id)};
console.log('Genomeshader: Bootstrap variables set', {{
  manifestUrl: window.GENOMESHADER_MANIFEST_URL,
  hasConfig: !!window.GENOMESHADER_CONFIG,
  viewId: window.GENOMESHADER_VIEW_ID
}});
</script>"""
        
        # Debug toolbar HTML
        debug_toolbar = """
<div class="gs-debug-toolbar">
  <button class="gs-debug-settings">Settings</button>
  <button class="gs-debug-sidebar">Toggle sidebar</button>
  <span class="gs-debug-status"></span>
</div>
"""

        # Mount script that initializes container after DOM is ready
        mount_script = f"""
<script type="text/javascript">
(function() {{
  // Wait for DOM to be ready
  if (document.readyState === 'loading') {{
    document.addEventListener('DOMContentLoaded', init);
  }} else {{
    // Use requestAnimationFrame to ensure layout has happened
    requestAnimationFrame(() => {{
      requestAnimationFrame(init);
    }});
  }}
  
  function init() {{
    const containerId = {json.dumps(container_id)};
    const root = document.getElementById(containerId);
    if (!root) {{
      console.error('Genomeshader: Container element not found:', containerId);
      return;
    }}
    
    // Store run_id in container dataset for easy access
    root.dataset.viewId = {json.dumps(run_id)};
    
    // Wire up debug toolbar buttons
    const viewId = {json.dumps(run_id)};
    
    // Test: Add a click listener to root to see if ANY clicks work
    root.addEventListener("click", (e) => {{
      console.log("[gs] DEBUG: Root click detected", e.target, e.target.className);
    }}, true);
    
    const wireDebugButtons = () => {{
      console.log("[gs] DEBUG: Looking for toolbar elements in root:", root.id);
      console.log("[gs] DEBUG: Root innerHTML length:", root.innerHTML.length);
      
      const settingsBtn = root.querySelector(".gs-debug-settings");
      const sidebarBtn  = root.querySelector(".gs-debug-sidebar");
      const statusEl    = root.querySelector(".gs-debug-status");
      
      // Also try document.querySelector as fallback
      const settingsBtnDoc = document.querySelector(".gs-debug-settings");
      const sidebarBtnDoc  = document.querySelector(".gs-debug-sidebar");
      const statusElDoc    = document.querySelector(".gs-debug-status");
      
      console.log("[gs] DEBUG: Elements found (root query):", {{
        settingsBtn: !!settingsBtn,
        sidebarBtn: !!sidebarBtn,
        statusEl: !!statusEl
      }});
      console.log("[gs] DEBUG: Elements found (document query):", {{
        settingsBtn: !!settingsBtnDoc,
        sidebarBtn: !!sidebarBtnDoc,
        statusEl: !!statusElDoc
      }});
      
      // Use document query results if root query failed
      const finalSettingsBtn = settingsBtn || settingsBtnDoc;
      const finalSidebarBtn = sidebarBtn || sidebarBtnDoc;
      const finalStatusEl = statusEl || statusElDoc;
      
      if (finalSettingsBtn && finalSidebarBtn && finalStatusEl) {{
        finalStatusEl.textContent = "wired";
        console.log("[gs] DEBUG: All toolbar elements found, wiring events...");
        console.log("[gs] DEBUG: Button elements:", {{
          settings: finalSettingsBtn,
          sidebar: finalSidebarBtn,
          status: finalStatusEl
        }});
        
        // Try both click and pointerdown events
        const handleSettingsClick = (e) => {{
          e.preventDefault(); 
          e.stopPropagation();
          console.log("[gs] DEBUG settings click", viewId, root.id, e.type, e.target);
          finalStatusEl.textContent = "settings clicked (" + e.type + ")";
        }};
        
        const handleSidebarClick = (e) => {{
          e.preventDefault(); 
          e.stopPropagation();
          console.log("[gs] DEBUG sidebar click", viewId, root.id, e.type, e.target);
          finalStatusEl.textContent = "sidebar clicked (" + e.type + ")";
        }};
        
        // Add both click and pointerdown handlers with capturing phase
        finalSettingsBtn.addEventListener("click", handleSettingsClick, true);
        finalSettingsBtn.addEventListener("pointerdown", handleSettingsClick, true);
        finalSettingsBtn.addEventListener("mousedown", handleSettingsClick, true);
        
        finalSidebarBtn.addEventListener("click", handleSidebarClick, true);
        finalSidebarBtn.addEventListener("pointerdown", handleSidebarClick, true);
        finalSidebarBtn.addEventListener("mousedown", handleSidebarClick, true);
        
        // Ensure buttons are clickable
        finalSettingsBtn.style.pointerEvents = "auto";
        finalSidebarBtn.style.pointerEvents = "auto";
        finalSettingsBtn.style.cursor = "pointer";
        finalSidebarBtn.style.cursor = "pointer";
        finalSettingsBtn.style.zIndex = "9999999";
        finalSidebarBtn.style.zIndex = "9999999";
        finalSettingsBtn.style.position = "relative";
        finalSidebarBtn.style.position = "relative";
        
        // Test direct onclick as fallback
        finalSettingsBtn.onclick = handleSettingsClick;
        finalSidebarBtn.onclick = handleSidebarClick;
        
        console.log("[gs] DEBUG: Event handlers attached to buttons");
        return true;
      }} else {{
        console.error("[gs] DEBUG toolbar elements not found", {{
          settingsBtn: finalSettingsBtn,
          sidebarBtn: finalSidebarBtn,
          statusEl: finalStatusEl,
          rootChildren: root.children.length,
          rootFirstChild: root.firstElementChild?.className,
          rootHTMLPreview: root.innerHTML.substring(0, 500)
        }});
        return false;
      }}
    }};
    
    // Try to wire immediately
    if (!wireDebugButtons()) {{
      // Retry after a short delay in case DOM isn't ready
      setTimeout(() => {{
        console.log("[gs] DEBUG: Retrying to wire debug buttons...");
        wireDebugButtons();
      }}, 100);
      
      // Also retry after longer delay
      setTimeout(() => {{
        console.log("[gs] DEBUG: Final retry to wire debug buttons...");
        wireDebugButtons();
      }}, 500);
    }}
    
    // Ensure container has dimensions before rendering
    const checkDimensions = () => {{
      const rect = root.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {{
        console.warn('Genomeshader: Container has zero dimensions, retrying...');
        // Wait a bit for layout to settle
        setTimeout(checkDimensions, 50);
        return;
      }}
      console.log('Genomeshader: Container dimensions:', rect.width, 'x', rect.height);
      
      // Trigger a resize event to ensure renderAll() runs with correct dimensions
      // This is especially important for WebGPU canvas initialization
      if (window.dispatchEvent) {{
        window.dispatchEvent(new Event('resize'));
      }}
    }};
    
    checkDimensions();
  }}
}})();
</script>"""

        # Wrap everything in container div with styles
        # The container needs to have a defined height for the app to render correctly
        # Override html/body height rules to work within container
        inline_html = f"""
<div id="{container_id}" style="width: 100%; height: 600px; position: relative; overflow: visible; background: var(--bg, #0b0d10); font-family: ui-sans-serif, system-ui; isolation: isolate;">
<style>
{styles}
/* Override html/body height rules for container embedding */
#{container_id} {{
  height: 600px;
  display: block;
  position: relative;
}}
/* Reset html/body styles within container - use :root for CSS variables */
#{container_id} {{
  --sidebar-w: 240px;
  --tracks-h: 280px;
  --flow-h: 500px;
  --reads-h: 220px;
}}
/* Use explicit positioning instead of grid for better Jupyter compatibility */
#{container_id} .app {{
  height: 100% !important;
  width: 100% !important;
  display: block !important; /* Override grid */
  position: relative !important;
  overflow: hidden;
}}
/* Sidebar: fixed width on the left */
#{container_id} .sidebar {{
  position: absolute !important;
  left: 0 !important;
  top: 0 !important;
  bottom: 0 !important;
  width: var(--sidebar-w, 240px) !important;
  z-index: 100 !important;
  overflow: visible !important;
  pointer-events: auto !important;
  transition: width 0.2s ease;
}}
/* Sidebar collapsed state */
#{container_id} .app.sidebar-collapsed .sidebar {{
  width: 12px !important;
  padding: 0 !important;
}}
#{container_id} .app.sidebar-collapsed .sidebar > * {{
  opacity: 0 !important;
  pointer-events: none !important;
}}
#{container_id} .app.sidebar-collapsed .sidebar::after {{
  pointer-events: auto !important;
  opacity: 1 !important;
  width: 12px !important;
}}
/* Main: takes remaining space to the right of sidebar */
#{container_id} .main {{
  position: absolute !important;
  left: var(--sidebar-w, 240px) !important;
  top: 0 !important;
  right: 0 !important;
  bottom: 0 !important;
  z-index: 1 !important;
  overflow: hidden;
  transition: left 0.2s ease;
}}
/* Main adjusted when sidebar is collapsed */
#{container_id} .app.sidebar-collapsed .main {{
  left: 12px !important;
}}
/* Ensure all sidebar children are clickable */
#{container_id} .sidebar > * {{
  pointer-events: auto !important;
  opacity: 1 !important;
}}
/* Ensure sidebar toggle border is clickable */
#{container_id} .sidebar::after {{
  z-index: 2147483000 !important;
  pointer-events: auto !important;
}}
/* Ensure gear button is clickable and above everything in sidebar */
#{container_id} .gearBtn {{
  z-index: 150 !important;
  position: absolute !important;
  pointer-events: auto !important;
  cursor: pointer !important;
  opacity: 1 !important;
}}
/* Ensure sidebar header is visible and clickable */
#{container_id} .sidebarHeader {{
  pointer-events: auto !important;
  opacity: 1 !important;
}}
/* Ensure participant groups are visible and clickable */
#{container_id} .group {{
  pointer-events: auto !important;
  opacity: 1 !important;
}}
/* Ensure menu is above everything - use fixed positioning set by JS */
#{container_id} .menu {{
  z-index: 2147483647 !important;
  display: none !important;
  visibility: hidden !important;
  background: var(--panel) !important;
  border: 1px solid var(--border) !important;
  box-shadow: var(--shadow) !important;
  opacity: 1 !important;
}}
#{container_id} .menu.open {{
  display: block !important;
  visibility: visible !important;
  position: fixed !important;
  pointer-events: auto !important;
  opacity: 1 !important;
}}
/* Ensure container doesn't clip the menu */
#{container_id} {{
  overflow: visible !important;
}}
/* Note: .main styles moved above with grid-column assignment */
/* Ensure tracks have proper dimensions within main area */
#{container_id} .tracks {{
  position: absolute !important;
  left: 0 !important;
  right: 0 !important;
  top: 0 !important;
  height: var(--tracks-h, 280px) !important;
  width: 100% !important;
}}
/* Ensure SVG fills tracks container */
#{container_id} #tracksSvg {{
  width: 100% !important;
  height: 100% !important;
  display: block !important;
}}
/* Ensure WebGPU canvas fills tracks container */
#{container_id} #tracksWebGPU {{
  width: 100% !important;
  height: 100% !important;
}}
/* Debug toolbar styles */
.gs-debug-toolbar{{
  position:absolute; top:8px; right:8px;
  z-index: 999999;
  display:flex; gap:8px; align-items:center;
}}
.gs-debug-toolbar button{{ padding:6px 10px; cursor:pointer; }}
.gs-debug-status{{ opacity:0.7; font-size:12px; }}
</style>
{bootstrap_script}
{debug_toolbar}
{body_content}
{mount_script}
</div>"""

        return inline_html


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

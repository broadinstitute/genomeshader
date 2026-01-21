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

# Try to import Comm for Jupyter comms
try:
    from ipykernel.comm import Comm
    COMM_AVAILABLE = True
except ImportError:
    Comm = None
    COMM_AVAILABLE = False

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
        
        # Comm for bidirectional communication
        self._comm = None
        
        # Store last rendered locus for on-demand loading
        self._last_locus = None
        
        # Sample mapping: VCF sample names -> BAM sample names
        # Format: {"VCF_sample1": ["BAM_sample1"], "VCF_sample2": ["BAM_sample2", "BAM_sample3"]}
        # If empty, assumes 1:1 identity mapping (VCF sample name == BAM sample name)
        self._sample_mapping: dict = {}

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
        Load and assemble template from modular components.
        
        Returns:
            str: The template HTML content as a string
        """
        from pathlib import Path
        
        # Determine base directory for HTML files
        base_dir = None
        
        # Try to get base directory from package resources first (when installed via pip)
        try:
            template_path = importlib.resources.files("genomeshader").joinpath("html", "template.html")
            if template_path.is_file():
                base_dir = template_path.parent
        except (AttributeError, FileNotFoundError, TypeError):
            pass
        
        # Fallback 1: Try relative path from this file (when installed via pip, html is in package)
        if base_dir is None:
            try:
                template_path = Path(__file__).parent / 'html' / 'template.html'
                if template_path.exists():
                    base_dir = template_path.parent
            except (FileNotFoundError, OSError):
                pass
        
        # Fallback 2: Try relative path from project root (for development)
        if base_dir is None:
            template_path = Path(__file__).parent.parent.parent / 'html' / 'template.html'
            if template_path.exists():
                base_dir = template_path.parent
            else:
                # Last resort: use current file's directory
                base_dir = Path(__file__).parent / 'html'
        
        # Load template skeleton
        template_path = base_dir / "template.html"
        template = template_path.read_text(encoding='utf-8')
        
        # Load CSS
        css_path = base_dir / "styles.css"
        css_content = css_path.read_text(encoding='utf-8')
        
        # Load body
        body_path = base_dir / "body.html"
        body_content = body_path.read_text(encoding='utf-8')
        
        # Load and concatenate JavaScript files in explicit order
        scripts_dir = base_dir / "scripts"
        script_order = [
            "cleanup.js",
            "webgpu-core.js",
            "webgpu-renderer.js",
            "webgpu-bezier.js",
            "jupyter-comms.js",
            "dom-utils.js",
            "ui-state.js",
            "view-state.js",
            "smart-tracks.js",
            "rendering.js",
            "tracks.js",
            "interaction.js",
            "main.js"
        ]
        js_content = "\n".join(
            (scripts_dir / name).read_text(encoding='utf-8')
            for name in script_order
            if (scripts_dir / name).exists()
        )
        
        # Replace placeholders in template
        template = template.replace("<!--__GENOMESHADER_STYLES__-->", f"<style>\n{css_content}\n</style>")
        template = template.replace("<!--__GENOMESHADER_BODY__-->", body_content)
        template = template.replace("<!--__GENOMESHADER_SCRIPTS__-->", f"<script type=\"module\">\n{js_content}\n</script>")
        
        return template

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

    def set_sample_mapping(self, mapping: dict):
        """
        Sets the mapping between VCF sample names and BAM file paths.
        
        This is useful when VCF samples need to be mapped to specific BAM files,
        or when one VCF sample corresponds to multiple BAM files.
        
        Args:
            mapping (dict): A dictionary mapping VCF sample names to lists of
                BAM file paths (URLs or local file paths).
                Format: {"VCF_sample1": ["gs://bucket/sample1.bam"], 
                         "VCF_sample2": ["gs://bucket/sample2_run1.bam", "gs://bucket/sample2_run2.bam"]}
                
        Example:
            >>> gs.set_sample_mapping({
            ...     "NA12878": ["gs://bucket/na12878_run1.bam", "gs://bucket/na12878_run2.bam"],
            ...     "NA12879": ["gs://bucket/na12879.bam"]
            ... })
        """
        self._sample_mapping = mapping
    
    def get_sample_mapping(self) -> dict:
        """
        Returns the current VCF-to-BAM sample mapping.
        
        Returns:
            dict: The sample mapping dictionary.
        """
        return self._sample_mapping
    
    def get_bam_samples_for_vcf_samples(self, vcf_samples: List[str]) -> List[str]:
        """
        Converts VCF sample names to BAM sample names using the sample mapping.
        
        If no mapping is set, assumes 1:1 identity mapping (VCF name == BAM name).
        
        Args:
            vcf_samples (List[str]): List of VCF sample names to convert.
            
        Returns:
            List[str]: List of unique BAM sample names corresponding to the
                given VCF samples.
        """
        bam_samples = set()
        for vcf_sample in vcf_samples:
            if self._sample_mapping and vcf_sample in self._sample_mapping:
                # Use mapping
                bam_samples.update(self._sample_mapping[vcf_sample])
            else:
                # Identity mapping (VCF name == BAM name)
                bam_samples.add(vcf_sample)
        return list(bam_samples)
    
    def get_bam_sample_names(self) -> List[str]:
        """
        Get sample names from attached BAM file headers.
        
        Returns a list of unique sample names extracted from the SM field
        in @RG (read group) headers of all attached BAM files.
        
        This is useful for debugging sample name mismatches between VCF
        and BAM files.
        
        Returns:
            List[str]: Sorted list of unique sample names from BAM headers.
        """
        return self._session.get_bam_sample_names()

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

    def get_locus_variants(self, locus: str) -> pl.DataFrame:
        """
        This function retrieves variant data for a locus from attached
        variant files (BCF/VCF).

        Args:
            locus (str): The locus to retrieve variant data for, in the format
                'chr:start-stop' or 'chr:position'.

        Returns:
            pl.DataFrame: A Polars DataFrame containing variant data with columns:
                - chromosome: Chromosome/contig name
                - position: Variant position (1-based)
                - ref_allele: Reference allele
                - alt_allele: Alternate allele
                - sample_name: Sample name
                - genotype: Genotype string (e.g., "0/1", "1/1", "./.")
                - variant_id: Unique variant identifier (internal index)
                - vcf_id: VCF/BCF ID field from the variant record (None if not present)
        """
        return self._session.get_locus_variants(locus)


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

        # Transform UCSC gene data to transcript format, then group by gene and compute exon union
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
        
        # Group transcripts by gene name
        genes_dict = {}
        for transcript in transcripts:
            gene_name = transcript['name']
            if gene_name not in genes_dict:
                genes_dict[gene_name] = []
            genes_dict[gene_name].append(transcript)
        
        # Compute exon union for each gene
        gene_models = []
        for gene_name, gene_transcripts in genes_dict.items():
            if not gene_transcripts:
                continue
            
            # Compute gene span: union of all transcript spans
            gene_start = min(t['start'] for t in gene_transcripts)
            gene_end = max(t['end'] for t in gene_transcripts)
            
            # Get strand (should be same for all transcripts of a gene)
            strand = gene_transcripts[0]['strand']
            
            # Collect all exons from all transcripts
            all_exons = []
            for transcript in gene_transcripts:
                for exon in transcript['exons']:
                    all_exons.append((exon[0], exon[1]))
            
            # Sort exons by start position
            all_exons.sort(key=lambda x: x[0])
            
            # Merge overlapping/adjacent exons to create union
            merged_exons = []
            if all_exons:
                current_start, current_end = all_exons[0]
                for exon_start, exon_end in all_exons[1:]:
                    # If overlapping or adjacent (within 1bp), merge
                    if exon_start <= current_end + 1:
                        current_end = max(current_end, exon_end)
                    else:
                        # No overlap, save current and start new
                        merged_exons.append((current_start, current_end))
                        current_start, current_end = exon_start, exon_end
                # Add the last merged exon
                merged_exons.append((current_start, current_end))
            
            # For each merged exon, determine if it's universal (in all transcripts) or partial
            exon_models = []
            for merged_start, merged_end in merged_exons:
                # Count how many transcripts contain this exon
                # An exon is "contained" if the merged exon overlaps with any exon in the transcript
                transcript_count = 0
                for transcript in gene_transcripts:
                    has_overlap = False
                    for exon_start, exon_end in transcript['exons']:
                        # Check if merged exon overlaps with transcript exon
                        if not (merged_end < exon_start or merged_start > exon_end):
                            has_overlap = True
                            break
                    if has_overlap:
                        transcript_count += 1
                
                # Mark as universal if present in all transcripts, otherwise partial
                is_universal = (transcript_count == len(gene_transcripts))
                exon_models.append([merged_start, merged_end, is_universal])
            
            # Create gene model
            gene_model = {
                'name': gene_name,
                'strand': strand,
                'start': gene_start,
                'end': gene_end,
                'exons': exon_models,
            }
            gene_models.append(gene_model)
        
        # Sort gene models by start position for lane assignment
        gene_models.sort(key=lambda g: g['start'])
        
        # Assign lanes to avoid overlaps (simple greedy algorithm)
        lanes = [[], [], []]  # Three lanes
        for gene_model in gene_models:
            assigned = False
            for lane_idx in range(3):
                # Check if gene overlaps with any existing gene in this lane
                overlaps = False
                for existing in lanes[lane_idx]:
                    # Check if intervals overlap
                    if not (gene_model['end'] < existing['start'] or gene_model['start'] > existing['end']):
                        overlaps = True
                        break
                
                if not overlaps:
                    gene_model['lane'] = lane_idx
                    lanes[lane_idx].append(gene_model)
                    assigned = True
                    break
            
            # If no lane available, assign to lane 0 anyway (will overlap)
            if not assigned:
                gene_model['lane'] = 0
                lanes[0].append(gene_model)
        
        return gene_models

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

        # Try to get variant data if locus is a string
        variants_df = None
        if isinstance(locus_or_dataframe, str):
            try:
                # Try to get variant data first
                variants_df = self.get_locus_variants(locus_or_dataframe)
                if variants_df is not None and isinstance(variants_df, pl.DataFrame) and len(variants_df) > 0:
                    samples_df = variants_df.clone()
                else:
                    # If no variant data, try reads
                    samples_df = self.get_locus(locus_or_dataframe)
            except Exception as e:
                # If variant extraction fails, fall back to reads
                try:
                    samples_df = self.get_locus(locus_or_dataframe)
                except Exception:
                    # Re-raise the original variant error if reads also fail
                    raise e
        elif isinstance(locus_or_dataframe, pl.DataFrame):
            samples_df = locus_or_dataframe.clone()
            # Check if this looks like variant data
            if "chromosome" in samples_df.columns and "position" in samples_df.columns:
                variants_df = samples_df.clone()
        else:
            raise ValueError(
                "locus_or_dataframe must be a locus string or a Polars DataFrame."
            )

        # Determine if we have variant data or read data
        is_variant_data = (
            "chromosome" in samples_df.columns and 
            "position" in samples_df.columns
        )
        
        if is_variant_data:
            # Extract region bounds from variant data
            ref_chr = samples_df["chromosome"].unique().sort().to_list()[0]
            ref_start = samples_df["position"].min()
            ref_end = samples_df["position"].max()
            # Add some padding for visualization
            padding = max(1000, (ref_end - ref_start) // 10)
            ref_start = max(1, ref_start - padding)
            ref_end = ref_end + padding
        else:
            # Extract region bounds from read data
            ref_chr = samples_df["reference_contig"].min()
            ref_start = samples_df["reference_start"].min()
            ref_end = samples_df["reference_end"].max()
        
        # Store the actual data bounds (where reads/variants exist)
        # These may differ from the displayed region if user zooms/pans
        data_start = int(ref_start)
        data_end = int(ref_end)

        # Format region string with commas for thousands
        region_str_formatted = f"{ref_chr}:{ref_start:,}-{ref_end:,}"

        # Compute stable run_id from region + genome_build
        region_str = f"{ref_chr}:{ref_start}-{ref_end}"
        hash_input = f"{region_str}:{self.genome_build}"
        run_id = hashlib.sha256(hash_input.encode('utf-8')).hexdigest()[:8]
        
        # Store view_id and locus for use in show() method and on-demand loading
        self._last_view_id = run_id
        self._last_locus = region_str

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

        # Transform variant data for frontend if we have variant data
        variants_data = []
        insertion_variants_lookup = []  # Precomputed sorted list for coordinate transformations
        if variants_df is not None and isinstance(variants_df, pl.DataFrame) and len(variants_df) > 0:
            # Get unique variant positions and their alleles
            # Include vcf_id if available, otherwise it will be None
            select_cols = ["position", "ref_allele", "alt_allele", "variant_id"]
            if "vcf_id" in variants_df.columns:
                select_cols.append("vcf_id")
            
            unique_variants = (
                variants_df
                .select(select_cols)
                .unique(subset=["position", "ref_allele", "alt_allele"])
                .sort("position")
            )
            
            # Group by position to collect all alt alleles for each position
            variant_groups = {}
            for row in unique_variants.iter_rows(named=True):
                pos = row["position"]
                ref_allele = row["ref_allele"]
                alt_allele = row["alt_allele"]
                variant_id = row["variant_id"]
                # Extract vcf_id - handle both None and Polars null values
                vcf_id = None
                if "vcf_id" in row:
                    vcf_id_val = row["vcf_id"]
                    # Polars nulls can be None, or sometimes need special handling
                    if vcf_id_val is not None:
                        vcf_id_str = str(vcf_id_val).strip()
                        # Accept any non-empty string that's not "." or "null" or "None"
                        if vcf_id_str and vcf_id_str != "." and vcf_id_str.lower() not in ("null", "none", ""):
                            vcf_id = vcf_id_str
                
                if pos not in variant_groups:
                    variant_groups[pos] = {
                        "pos": pos,
                        "refAllele": ref_allele,
                        "altAlleles": [],
                        "variant_id": variant_id,
                        "vcf_id": vcf_id,
                        "variant_display_ids": [],
                    }

                # Determine display ID for this row (prefers VCF ID when available)
                row_display_id = str(vcf_id) if vcf_id else str(variant_id)
                if row_display_id not in variant_groups[pos]["variant_display_ids"]:
                    variant_groups[pos]["variant_display_ids"].append(row_display_id)
                
                if alt_allele not in variant_groups[pos]["altAlleles"]:
                    variant_groups[pos]["altAlleles"].append(alt_allele)
            
            # Collect display IDs for each position so we include duplicates that were collapsed
            for row in variants_df.iter_rows(named=True):
                pos = row["position"]
                if pos not in variant_groups:
                    continue
                row_vcf_id = None
                if "vcf_id" in row:
                    vcf_id_val = row["vcf_id"]
                    if vcf_id_val is not None:
                        vcf_id_str = str(vcf_id_val).strip()
                        if vcf_id_str and vcf_id_str != "." and vcf_id_str.lower() not in ("null", "none", ""):
                            row_vcf_id = vcf_id_str
                row_variant_id = row["variant_id"]
                row_display_id = str(row_vcf_id) if row_vcf_id else str(row_variant_id)
                display_ids = variant_groups[pos].setdefault("variant_display_ids", [])
                if row_display_id not in display_ids:
                    display_ids.append(row_display_id)

            # Calculate allele frequencies for each variant
            # Filter variants_df to get genotype data for frequency calculation
            if "genotype" in variants_df.columns and "sample_name" in variants_df.columns:
                # Group by position to calculate frequencies per variant
                for pos, variant_info in variant_groups.items():
                    # Filter variants_df for this specific position and alleles
                    pos_df = variants_df.filter(
                        (pl.col("position") == pos) &
                        (pl.col("ref_allele") == variant_info["refAllele"])
                    )
                    
                    # Count allele occurrences
                    allele_counts = {
                        ".": 0,  # no-call
                        "ref": 0,  # reference (index 0)
                    }
                    # Initialize alt allele counts
                    for i in range(len(variant_info["altAlleles"])):
                        allele_counts[f"a{i+1}"] = 0
                    
                    total_alleles = 0
                    
                    # Parse genotypes and count alleles
                    for row in pos_df.iter_rows(named=True):
                        gt_str = row.get("genotype", "./.")
                        if not gt_str or gt_str == "./.":
                            allele_counts["."] += 2  # Assume diploid missing
                            total_alleles += 2
                        else:
                            # Parse genotype string (e.g., "0/1", "1/1", "0|1", "1")
                            parts = gt_str.replace("|", "/").split("/")
                            for part in parts:
                                part = part.strip()
                                if part == "." or part == "":
                                    allele_counts["."] += 1
                                    total_alleles += 1
                                else:
                                    try:
                                        allele_idx = int(part)
                                        total_alleles += 1
                                        if allele_idx == 0:
                                            allele_counts["ref"] += 1
                                        elif allele_idx <= len(variant_info["altAlleles"]):
                                            allele_counts[f"a{allele_idx}"] += 1
                                        else:
                                            # Out of range allele index, count as no-call
                                            allele_counts["."] += 1
                                    except ValueError:
                                        # Invalid allele index, count as no-call
                                        allele_counts["."] += 1
                                        total_alleles += 1
                    
                    # Calculate frequencies
                    allele_frequencies = {}
                    if total_alleles > 0:
                        for allele, count in allele_counts.items():
                            allele_frequencies[allele] = count / total_alleles
                    else:
                        # Fallback: equal frequencies if no data
                        num_alleles = 1 + len(variant_info["altAlleles"]) + 1  # ref + alts + no-call
                        for allele in allele_counts.keys():
                            allele_frequencies[allele] = 1.0 / num_alleles
                    
                    # Normalize frequencies to sum to 1.0
                    total_freq = sum(allele_frequencies.values())
                    if total_freq > 0:
                        for allele in allele_frequencies:
                            allele_frequencies[allele] /= total_freq
                    
                    variant_info["alleleFrequencies"] = allele_frequencies
            else:
                # No genotype data available, set equal frequencies as fallback
                for pos, variant_info in variant_groups.items():
                    num_alleles = 1 + len(variant_info["altAlleles"]) + 1  # ref + alts + no-call
                    allele_frequencies = {
                        ".": 1.0 / num_alleles,
                        "ref": 1.0 / num_alleles,
                    }
                    for i in range(len(variant_info["altAlleles"])):
                        allele_frequencies[f"a{i+1}"] = 1.0 / num_alleles
                    variant_info["alleleFrequencies"] = allele_frequencies
            
            # Collect sample genotypes for each variant
            # Group genotypes by sample and variant position
            sample_genotypes = {}  # {sample_name: {position: genotype_string}}
            if "genotype" in variants_df.columns and "sample_name" in variants_df.columns:
                for row in variants_df.iter_rows(named=True):
                    sample_name = row.get("sample_name")
                    pos = row.get("position")
                    genotype = row.get("genotype", "./.")
                    ref_allele = row.get("ref_allele")
                    
                    if sample_name not in sample_genotypes:
                        sample_genotypes[sample_name] = {}
                    
                    # Store genotype for this position and ref_allele combination
                    # Use (pos, ref_allele) as key since we group by position
                    key = (pos, ref_allele)
                    if key not in sample_genotypes[sample_name]:
                        sample_genotypes[sample_name][key] = genotype
            
            # Helper function to format allele labels (matches JavaScript formatAlleleLabel logic)
            def format_allele_label(allele):
                """Format allele label to match JavaScript formatAlleleLabel function."""
                if not allele or allele == ".":
                    return ". (no-call)"
                length = len(allele)
                length_label = "1 bp" if length == 1 else f"{length} bp"
                # Truncate to 50 bp and add "..." if longer
                display_allele = allele[:50] + "..." if length > 50 else allele
                return f"{display_allele} ({length_label})"
            
            # Convert to frontend format
            for idx, (pos, variant_info) in enumerate(sorted(variant_groups.items())):
                # Use VCF ID if available (numeric IDs like "59434" are valid), otherwise use variant_id index
                vcf_id = variant_info.get("vcf_id")
                if vcf_id:
                    variant_display_id = str(vcf_id)
                else:
                    variant_display_id = str(variant_info['variant_id'])
                
                # Get genotypes for this variant from all samples
                variant_genotypes = {}  # {sample_name: genotype_string}
                key = (pos, variant_info["refAllele"])
                for sample_name, sample_data in sample_genotypes.items():
                    if key in sample_data:
                        variant_genotypes[sample_name] = sample_data[key]
                
                # Precompute variant type metadata for performance
                ref_allele = variant_info["refAllele"]
                alt_alleles = variant_info["altAlleles"]
                ref_len = len(ref_allele) if ref_allele else 0
                
                # Check if any alt allele is longer than ref (insertion)
                is_insertion = False
                max_insertion_length = 0
                is_deletion = False
                variant_type = "snv"  # default
                
                if alt_alleles:
                    for alt in alt_alleles:
                        alt_len = len(alt) if alt else 0
                        if alt_len > ref_len:
                            is_insertion = True
                            max_insertion_length = max(max_insertion_length, alt_len - ref_len)
                        elif alt_len < ref_len:
                            is_deletion = True
                
                # Determine variant type
                if is_insertion and is_deletion:
                    variant_type = "complex"  # mixed insertion/deletion
                elif is_insertion:
                    variant_type = "insertion"
                elif is_deletion:
                    variant_type = "deletion"
                else:
                    variant_type = "snv"  # substitution or same length
                
                # Precompute insertion gap width in pixels (8px per inserted base)
                insertion_gap_px = max_insertion_length * 8 if is_insertion else 0
                
                # Precompute formatted allele labels for performance
                formatted_ref_allele = format_allele_label(ref_allele) if ref_allele else None
                formatted_alt_alleles = [format_allele_label(alt) for alt in alt_alleles] if alt_alleles else []
                
                variants_data.append({
                    "id": variant_display_id,
                    "pos": variant_info["pos"],
                    "refAllele": variant_info["refAllele"],
                    "altAlleles": variant_info["altAlleles"],
                    "alleles": ["ref"] + [f"a{i+1}" for i in range(len(variant_info["altAlleles"]))],
                    "alleleFrequencies": variant_info.get("alleleFrequencies", {}),
                    "sampleGenotypes": variant_genotypes,  # Add genotype data per sample
                    "displayIds": variant_info.get("variant_display_ids", [variant_display_id]),
                    # Precomputed variant type metadata for performance
                    "isInsertion": is_insertion,
                    "maxInsertionLength": max_insertion_length,
                    "variantType": variant_type,
                    "insertionGapPx": insertion_gap_px,  # Precomputed gap width in pixels
                    # Precomputed formatted allele labels for performance
                    "formattedRefAllele": formatted_ref_allele,
                    "formattedAltAlleles": formatted_alt_alleles,
                })
            
            # Precompute sorted list of insertion variants for efficient coordinate transformation lookups
            # This enables binary search instead of linear iteration
            for variant in variants_data:
                if variant.get("isInsertion") and variant.get("insertionGapPx", 0) > 0:
                    insertion_variants_lookup.append({
                        "id": variant["id"],
                        "pos": variant["pos"],
                        "insertionGapPx": variant["insertionGapPx"],
                    })
            # Sort by position for binary search
            insertion_variants_lookup.sort(key=lambda v: v["pos"])

        # Load template HTML
        template_html = self._load_template_html()

        # Get manifest URL using localhost server (available if needed later)
        _ = self._get_manifest_url(manifest_path)

        # Check if comms are available for bidirectional communication
        comm_available = COMM_AVAILABLE

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
            'variants_data': variants_data,  # Add variant data to config
            'insertion_variants_lookup': insertion_variants_lookup,  # Precomputed sorted list for coordinate transformations
            'data_bounds': {
                'start': data_start,
                'end': data_end,
            },
            'comm_available': comm_available,  # Indicates if Jupyter comms are available
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
        
        # Build bootstrap snippet with config and view ID
        bootstrap = f"""<script>
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
        
        # Extract body content and scripts separately to avoid f-string issues with JavaScript curly braces
        body_match = re.search(r'<body[^>]*>(.*?)</body>', final_html, re.DOTALL)
        if body_match:
            full_body_content = body_match.group(1)
            # Extract script tag content separately (the entire script tag, not just content)
            script_match = re.search(r'(<script[^>]*type=["\']module["\'][^>]*>.*?</script>)', full_body_content, re.DOTALL)
            if script_match:
                script_tag = script_match.group(1)
                # Remove script tag from body content
                body_content = re.sub(r'<script[^>]*type=["\']module["\'][^>]*>.*?</script>', '', full_body_content, flags=re.DOTALL)
            else:
                body_content = full_body_content
                script_tag = None
        else:
            # Fallback: if no body tag found, use entire template
            body_content = final_html
            script_tag = None

        # Generate inline HTML with container div, styles, and bootstrap script
        container_id = f"genomeshader-root-{run_id}"
        
        # Bootstrap script must run FIRST to set window variables before template scripts execute
        # The bootstrap is already injected into final_html, but we need to include it in inline output
        # Use string formatting instead of f-strings to avoid issues with curly braces
        config_json = json.dumps(config)
        jupyter_origin_json = json.dumps(jupyter_origin)
        run_id_json = json.dumps(run_id)
        bootstrap_script = (
            "<script type=\"text/javascript\">\n"
            "// Bootstrap: Set window variables before template scripts run\n"
            f"window.GENOMESHADER_CONFIG = {config_json};\n"
            f"window.GENOMESHADER_JUPYTER_ORIGIN = {jupyter_origin_json};\n"
            f"window.GENOMESHADER_VIEW_ID = {run_id_json};\n"
            "console.log('Genomeshader: Bootstrap variables set', {\n"
            "  hasConfig: !!window.GENOMESHADER_CONFIG,\n"
            "  viewId: window.GENOMESHADER_VIEW_ID\n"
            "});\n"
            "</script>"
        )
        
        # Mount script that initializes container after DOM is ready
        # Use string formatting instead of f-strings to avoid issues with curly braces
        container_id_json = json.dumps(container_id)
        mount_script = (
            "<script type=\"text/javascript\">\n"
            "(function() {\n"
            "  // Wait for DOM to be ready\n"
            "  if (document.readyState === 'loading') {\n"
            "    document.addEventListener('DOMContentLoaded', init);\n"
            "  } else {\n"
            "    // Use requestAnimationFrame to ensure layout has happened\n"
            "    requestAnimationFrame(() => {\n"
            "      requestAnimationFrame(init);\n"
            "    });\n"
            "  }\n"
            "  \n"
            "  function init() {\n"
            f"    const containerId = {container_id_json};\n"
            "    const root = document.getElementById(containerId);\n"
            "    if (!root) {\n"
            "      console.error('Genomeshader: Container element not found:', containerId);\n"
            "      return;\n"
            "    }\n"
            "    \n"
            "    // Store run_id in container dataset for easy access\n"
            f"    root.dataset.viewId = {run_id_json};\n"
            "    \n"
            "    // Ensure container has dimensions before rendering\n"
            "    const checkDimensions = () => {\n"
            "      const rect = root.getBoundingClientRect();\n"
            "      if (rect.width === 0 || rect.height === 0) {\n"
            "        console.warn('Genomeshader: Container has zero dimensions, retrying...');\n"
            "        // Wait a bit for layout to settle\n"
            "        setTimeout(checkDimensions, 50);\n"
            "        return;\n"
            "      }\n"
            "      console.log('Genomeshader: Container dimensions:', rect.width, 'x', rect.height);\n"
            "      \n"
            "      // Trigger a resize event to ensure renderAll() runs with correct dimensions\n"
            "      // This is especially important for WebGPU canvas initialization\n"
            "      if (window.dispatchEvent) {\n"
            "        window.dispatchEvent(new Event('resize'));\n"
            "      }\n"
            "    };\n"
            "    \n"
            "    checkDimensions();\n"
            "  }\n"
            "})();\n"
            "</script>"
        )

        # Wrap everything in container div with styles
        # The container needs to have a defined height for the app to render correctly
        # Override html/body height rules to work within container
        # Use string concatenation instead of f-strings to avoid issues with curly braces in content
        inline_html_parts = [
            f'<div id="{container_id}" style="width: 100%; height: 600px; position: relative; overflow: visible; background: var(--bg, #0b0d10); font-family: ui-sans-serif, system-ui; isolation: isolate;">',
            '<style>',
            styles,  # Insert styles directly (no f-string interpolation)
            f'/* Override html/body height rules for container embedding */\n#{container_id} {{\n  height: 600px;\n  display: block;\n  position: relative;\n}}',
            f'/* Reset html/body styles within container - use :root for CSS variables */\n#{container_id} {{\n  --sidebar-w: 240px;\n  --tracks-h: 280px;\n  --flow-h: 500px;\n  --reads-h: 220px;\n}}',
            f'/* Use explicit positioning instead of grid for better Jupyter compatibility */\n#{container_id} .app {{\n  height: 100% !important;\n  width: 100% !important;\n  display: block !important; /* Override grid */\n  position: relative !important;\n  overflow: hidden;\n}}',
            f'/* Sidebar: fixed width on the left */\n#{container_id} .sidebar {{\n  position: absolute !important;\n  left: 0 !important;\n  top: 0 !important;\n  bottom: 0 !important;\n  width: var(--sidebar-w, 240px) !important;\n  z-index: 100 !important;\n  overflow-y: auto !important;\n  overflow-x: visible !important;\n  pointer-events: auto !important;\n  transition: width 0.2s ease;\n}}',
            f'/* Sidebar collapsed state */\n#{container_id} .app.sidebar-collapsed .sidebar {{\n  width: 12px !important;\n  padding: 0 !important;\n}}\n#{container_id} .app.sidebar-collapsed .sidebar > * {{\n  opacity: 0 !important;\n  pointer-events: none !important;\n}}\n#{container_id} .app.sidebar-collapsed .sidebar::after {{\n  pointer-events: auto !important;\n  opacity: 1 !important;\n  width: 12px !important;\n}}',
            f'/* Main: takes remaining space to the right of sidebar */\n#{container_id} .main {{\n  position: absolute !important;\n  left: var(--sidebar-w, 240px) !important;\n  top: 0 !important;\n  right: 0 !important;\n  bottom: 0 !important;\n  z-index: 1 !important;\n  overflow: hidden;\n  transition: left 0.2s ease;\n}}',
            f'/* Main adjusted when sidebar is collapsed */\n#{container_id} .app.sidebar-collapsed .main {{\n  left: 12px !important;\n}}',
            f'/* Ensure all sidebar children are clickable */\n#{container_id} .sidebar > * {{\n  pointer-events: auto !important;\n  opacity: 1 !important;\n}}',
            f'/* Ensure sidebar toggle border is clickable - but only on the right edge */\n#{container_id} .sidebar::after {{\n  z-index: 5 !important;\n  pointer-events: auto !important;\n  width: 4px !important;\n  left: auto !important;\n  right: 0 !important;\n}}',
            f'/* Ensure gear button is clickable and above everything in sidebar */\n#{container_id} .gearBtn {{\n  z-index: 150 !important;\n  position: absolute !important;\n  left: 12px !important;\n  bottom: 12px !important;\n  pointer-events: auto !important;\n  cursor: pointer !important;\n  opacity: 1 !important;\n}}',
            f'/* Ensure sidebar header is visible and clickable */\n#{container_id} .sidebarHeader {{\n  pointer-events: auto !important;\n  opacity: 1 !important;\n}}',
            f'/* Ensure participant groups are visible and clickable */\n#{container_id} .group {{\n  pointer-events: auto !important;\n  opacity: 1 !important;\n}}',
            f'/* Ensure all form elements in sidebar are clickable and interactive */\n#{container_id} .sidebar select,\n#{container_id} .sidebar input,\n#{container_id} .sidebar button,\n#{container_id} .sidebar label {{\n  pointer-events: auto !important;\n  position: relative !important;\n  z-index: 200 !important;\n}}',
            f'/* Style for select dropdown to ensure it\'s visible */\n#{container_id} .sidebar select {{\n  -webkit-appearance: menulist !important;\n  -moz-appearance: menulist !important;\n  appearance: menulist !important;\n  cursor: pointer !important;\n}}',
            f'/* Style for range input to ensure it\'s interactive */\n#{container_id} .sidebar input[type="range"] {{\n  -webkit-appearance: auto !important;\n  appearance: auto !important;\n  cursor: pointer !important;\n}}',
            f'/* Style for number input */\n#{container_id} .sidebar input[type="number"] {{\n  -webkit-appearance: auto !important;\n  appearance: auto !important;\n}}',
            f'/* Style for text input */\n#{container_id} .sidebar input[type="text"] {{\n  -webkit-appearance: auto !important;\n  appearance: auto !important;\n  cursor: text !important;\n}}',
            f'/* Fix for nested elements in sample selection section */\n#{container_id} #sampleStrategySection,\n#{container_id} #sampleStrategySection *,\n#{container_id} #sampleSearchSection,\n#{container_id} #sampleSearchSection *,\n#{container_id} #sampleContext,\n#{container_id} #sampleContext * {{\n  pointer-events: auto !important;\n}}',
            f'/* Ensure sample strategy section has proper stacking context */\n#{container_id} #sampleStrategySection {{\n  position: relative !important;\n  z-index: 200 !important;\n}}\n#{container_id} #sampleSearchSection {{\n  position: relative !important;\n  z-index: 200 !important;\n}}',
            f'/* Ensure sidebar content is above any potential overlays */\n#{container_id} .sidebar .sidebarHeader,\n#{container_id} .sidebar .group {{\n  position: relative !important;\n  z-index: 200 !important;\n}}',
            f'/* Ensure menu is above everything - use fixed positioning set by JS */\n#{container_id} .menu {{\n  z-index: 2147483647 !important;\n  display: none !important;\n  visibility: hidden !important;\n  background: var(--panel) !important;\n  border: 1px solid var(--border) !important;\n  box-shadow: var(--shadow) !important;\n  opacity: 1 !important;\n}}\n#{container_id} .menu.open {{\n  display: block !important;\n  visibility: visible !important;\n  position: fixed !important;\n  pointer-events: auto !important;\n  opacity: 1 !important;\n}}',
            f'/* Ensure container doesn\'t clip the menu */\n#{container_id} {{\n  overflow: visible !important;\n}}',
            f'/* Note: .main styles moved above with grid-column assignment */\n/* Ensure tracks have proper dimensions within main area */\n#{container_id} .tracks {{\n  position: absolute !important;\n  left: 0 !important;\n  right: 0 !important;\n  top: 0 !important;\n  height: var(--tracks-h, 280px) !important;\n  width: 100% !important;\n}}',
            f'/* Ensure tracksContainer is positioned relatively for absolute children */\n#{container_id} #tracksContainer {{\n  position: relative !important;\n  width: 100% !important;\n  height: 100% !important;\n}}',
            f'/* Ensure SVG fills tracks container */\n#{container_id} #tracksSvg {{\n  width: 100% !important;\n  height: 100% !important;\n  display: block !important;\n}}',
            f'/* Ensure WebGPU canvas fills tracks container */\n#{container_id} #tracksWebGPU {{\n  position: absolute !important;\n  inset: 0 !important;\n  width: 100% !important;\n  height: 100% !important;\n  display: block !important;\n  pointer-events: auto !important;\n  z-index: 1 !important;\n}}',
            '</style>',
            bootstrap_script,  # Insert bootstrap script directly (no f-string interpolation)
            body_content,  # Insert body content directly (no f-string interpolation)
            mount_script,  # Insert mount script directly (no f-string interpolation)
        ]
        
        # Add script tag if present
        if script_tag:
            inline_html_parts.append(script_tag)
        
        inline_html_parts.append('</div>')
        
        # Filter out None values and ensure all parts are strings
        inline_html_parts = [str(part) for part in inline_html_parts if part is not None]
        
        # Join all parts
        inline_html = '\n'.join(inline_html_parts)
        
        return inline_html


    def show(
        self,
        locus: str,
    ):
        """
        Visualizes variant data for a genomic locus by fetching variant data
        and rendering a graphical representation.

        Parameters:
            locus (str): The genomic locus to visualize, in the format
                'chromosome:start-stop' or 'chromosome:position'
                (e.g., 'chr1:1000000-2000000' or 'chr1:1000000').

        Returns:
            None: Displays the visualization in the notebook.
        """
        # Fetch variant data for the locus
        variants_df = self.get_locus_variants(locus)
        html_script = self.render(variants_df)
        # view_id available via self._last_view_id if needed

        # Register comm target for JavaScript to connect to
        if COMM_AVAILABLE:
            try:
                from IPython import get_ipython
                ip = get_ipython()
                if ip is not None and hasattr(ip, 'kernel') and ip.kernel is not None:
                    gs_instance = self
                    
                    def handle_comm_open(comm, msg):
                        """Handle comm open from JavaScript."""
                        print(f"Genomeshader: Comm opened, id: {comm.comm_id}")
                        
                        @comm.on_msg
                        def _recv(msg):
                            data = msg['content']['data']
                            msg_type = data.get('type')
                            request_id = data.get('request_id')
                            
                            if msg_type == 'test':
                                comm.send({
                                    'type': 'test_response',
                                    'request_id': request_id,
                                    'message': f'Hello from Python! Got: {data.get("message", "")}',
                                })
                            
                            elif msg_type == 'fetch_reads':
                                # Fetch reads for the current locus from attached BAM files
                                try:
                                    locus = gs_instance._last_locus
                                    if locus is None:
                                        comm.send({
                                            'type': 'fetch_reads_error',
                                            'request_id': request_id,
                                            'error': 'No locus available',
                                        })
                                        return
                                    
                                    # Get Smart track parameters (optional)
                                    strategy = data.get('strategy', None)
                                    selected_alleles = data.get('selected_alleles', None)
                                    sample_id = data.get('sample_id', None)
                                    
                                    # Get sample filter from message (optional)
                                    # For Smart tracks, sample_id takes precedence over samples array
                                    vcf_samples = data.get('samples', None)
                                    if sample_id and not vcf_samples:
                                        # Use sample_id if provided
                                        vcf_samples = [sample_id]
                                    
                                    # Get BAM file URLs from sample mapping
                                    bam_urls = []
                                    if vcf_samples:
                                        # Use sample mapping to get BAM file paths
                                        mapped = gs_instance.get_bam_samples_for_vcf_samples(vcf_samples)
                                        
                                        if mapped:
                                            # Mapped values should always be BAM file paths/URLs
                                            bam_urls = mapped
                                        else:
                                            error_msg = f'No BAM files found in mapping for sample(s): {vcf_samples}. Please check your sample mapping.'
                                            comm.send({
                                                'type': 'fetch_reads_error',
                                                'request_id': request_id,
                                                'error': error_msg,
                                            })
                                            return
                                    else:
                                        # No sample specified - this shouldn't happen for Smart tracks, but handle gracefully
                                        error_msg = 'No sample_id or samples provided. Cannot determine which BAM files to load.'
                                        comm.send({
                                            'type': 'fetch_reads_error',
                                            'request_id': request_id,
                                            'error': error_msg,
                                        })
                                        return
                                    
                                    if not bam_urls:
                                        error_msg = f'No BAM files found for sample(s): {vcf_samples}. Please check your sample mapping.'
                                        comm.send({
                                            'type': 'fetch_reads_error',
                                            'request_id': request_id,
                                            'error': error_msg,
                                        })
                                        return
                                    
                                    # Use the Rust-based fetch with specified BAM URLs
                                    try:
                                        reads_df = gs_instance._session.fetch_reads_for_locus(locus, bam_urls)
                                    except Exception as e:
                                        import traceback
                                        traceback.print_exc()
                                        comm.send({
                                            'type': 'fetch_reads_error',
                                            'request_id': request_id,
                                            'error': f'Failed to fetch reads: {str(e)}',
                                        })
                                        return
                                    
                                    # NOTE: We're NOT filtering by sample_id here because:
                                    # 1. The BAM files were already selected based on the sample mapping
                                    # 2. The sample_name in the BAM file (from @RG SM tag) might be different from the VCF sample_id
                                    # 3. Since we're loading from the correct BAM files, all reads should be for the correct sample
                                    
                                    # TODO: Filter reads based on selected_alleles if provided
                                    # This would require matching reads to specific alleles
                                    
                                    # Convert to JSON-serializable format
                                    reads_data = reads_df.to_dict(as_series=False)
                                    
                                    comm.send({
                                        'type': 'fetch_reads_response',
                                        'request_id': request_id,
                                        'locus': locus,
                                        'reads': reads_data,
                                        'count': len(reads_df),
                                        'bam_urls': bam_urls,  # Include which BAM files were loaded from
                                        'vcf_samples': vcf_samples,  # Include which VCF samples were requested
                                        'sample_id': sample_id,  # Include sample_id if provided
                                        'strategy': strategy,  # Include strategy if provided
                                    })
                                except Exception as e:
                                    print(f"Genomeshader: Error in fetch_reads: {e}")
                                    import traceback
                                    traceback.print_exc()
                                    comm.send({
                                        'type': 'fetch_reads_error',
                                        'request_id': request_id,
                                        'error': str(e),
                                    })
                        
                        gs_instance._comm = comm
                    
                    ip.kernel.comm_manager.register_target('genomeshader', handle_comm_open)
            except Exception as e:
                print(f"Genomeshader: Failed to register comm target: {e}")
        
        # Display the HTML
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

import os
import re
from enum import Enum
from typing import Union, List

import requests
import requests_cache
import polars as pl

from IPython.display import display, HTML
import json
import gzip
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

        return ideo_df.write_json()

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

        ideo_json = self.ideogram(ref_chr)
        gene_json = self.genes(ref_chr, ref_start, ref_end)
        ref_json = self.reference(ref_chr, ref_start, ref_end)

        data_to_pass = {
            "ideogram": json.loads(ideo_json),
            "genes": json.loads(gene_json),
            "ref_chr": ref_chr,
            "ref_start": ref_start,
            "ref_end": ref_end,
        }

        data_json = json.dumps(data_to_pass)

        # Compress JSON data using gzip
        compressed_samples = gzip.compress(samples_df.write_json().encode('utf-8'))
        compressed_ref = gzip.compress(ref_json.encode('utf-8'))

        # Encode compressed data to base64 to embed in HTML safely
        encoded_samples = base64.b64encode(compressed_samples).decode('utf-8')
        encoded_ref = base64.b64encode(compressed_ref).decode('utf-8')

        inner_style = """
body {
    display: grid;
    grid-template-areas: 
        "header header header"
        "main main aside"
        "footer footer aside";
    grid-template-rows: auto 1fr auto;
    grid-template-columns: 1fr auto;
    height: 100vh;
    margin: 0;
    padding: 0;
    overflow: hidden;
}
header {
    grid-area: header;
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    height: 24px;
    padding: 6px 3px;
    background: #eeeeee;
}
.header-left {
    display: flex;
    align-items: center;
    justify-content: flex-start;
}
.header-center {
    display: flex;
    align-items: center;
    justify-content: center;
}
.header-right {
    display: flex;
    align-items: center;
    justify-content: flex-end;
}
.header-left i, .header-right i {
    padding-left: 5px;
    padding-right: 5px;
}
nav {
    grid-area: nav;
}
main {
    grid-area: main;
    height: calc(100vh - 24px - 40px);
}
aside {
    display: hidden;
    grid-area: aside;
    transition: width 0.3s;
    background-color: #cccccc;
    border-left: 1px solid #bbbbbb;
    max-width: 300px;
    width: 0;
    overflow: hidden;
}
.menu-icon {
    cursor: pointer;
}
.sidebar-icon-close {
    display: none;
    cursor: pointer;
}
.sidebar-icon-open {
    cursor: pointer;
}
.report-bug-icon {
    cursor: pointer;
}
.gear-icon {
    cursor: pointer;
}
footer {
    position: fixed;
    bottom: 10px;
    left: 10px;
    right: 210px;
    height: 20px;
    padding: 6px 3px;
    display: flex;
    align-items: center;
    justify-content: left;
    color: #989898;
    font-family: Helvetica;
    font-size: 10pt;
    user-select: none; /* Disable text selection */
    -webkit-user-select: none; /* Safari */
    -moz-user-select: none; /* Firefox */
    -ms-user-select: none; /* Internet Explorer/Edge */
}
.tab-bar {
    height: 22px;
    color: #ffffff;
    font-family: Helvetica;
    font-size: 9pt;
    font-weight: bold;
    background-color: #888888;
    display: flex;
    align-items: flex-end;
}
.tab-name {
    color: #ffffff;
    padding: 3px 3px;
    margin: 2px 2px;
    font-family: Helvetica;
    font-size: 9pt;
    font-weight: bold;
}
.tab-content-viewer {
    color: #ffffff;
    padding: 4px;
    margin: 0px;
    color: #a8a8a8;
    background-color: #ffffff;
    font-family: Helvetica;
    font-size: 9pt;
    font-weight: bold;
}
.tab-content-info {
    color: #ffffff;
    padding: 20px 8px;
    margin: 0px;
    color: #585858;
    font-family: Helvetica;
    font-size: 9pt;
}
        """

        inner_body = """
<header>
    <div class="header-left">
        <i class="menu-icon" onclick="alert('Not yet implemented.')">
            <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px" width="18" height="18" viewBox="0 0 24 24">
                <g transform="translate(0, 0)">
                    <path d="M4 6H20M4 12H20M4 18H20" stroke="#000000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
                </g>
            </svg>
        </i>
    </div>
    <div class="header-center">
        <!-- genomeshader -->
    </div>
    <div class="header-right">
        <i class="sidebar-icon-close" onclick="closeSidebar()">
            <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px" width="18" height="18" viewBox="0 0 24 24">
                <g transform="translate(0, 0)">
                    <path fill-rule="evenodd" d="M7.22 14.47L9.69 12 7.22 9.53a.75.75 0 111.06-1.06l3 3a.75.75 0 010 1.06l-3 3a.75.75 0 01-1.06-1.06z"></path>
                    <path fill-rule="evenodd" d="M3.75 2A1.75 1.75 0 002 3.75v16.5c0 .966.784 1.75 1.75 1.75h16.5A1.75 1.75 0 0022 20.25V3.75A1.75 1.75 0 0020.25 2H3.75zM3.5 3.75a.25.25 0 01.25-.25H15v17H3.75a.25.25 0 01-.25-.25V3.75zm13 16.75v-17h3.75a.25.25 0 01.25.25v16.5a.25.25 0 01-.25.25H16.5z"></path>
                </g>
            </svg>
        </i>
        <i class="sidebar-icon-open" onclick="openSidebar()">
            <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px" width="18" height="18" viewBox="0 0 24 24">
                <g transform="translate(0, 0)">
                    <path fill-rule="evenodd" d="M11.28 9.53L8.81 12l2.47 2.47a.75.75 0 11-1.06 1.06l-3-3a.75.75 0 010-1.06l3-3a.75.75 0 111.06 1.06z"></path>
                    <path fill-rule="evenodd" d="M3.75 2A1.75 1.75 0 002 3.75v16.5c0 .966.784 1.75 1.75 1.75h16.5A1.75 1.75 0 0022 20.25V3.75A1.75 1.75 0 0020.25 2H3.75zM3.5 3.75a.25.25 0 01.25-.25H15v17H3.75a.25.25 0 01-.25-.25V3.75zm13 16.75v-17h3.75a.25.25 0 01.25.25v16.5a.25.25 0 01-.25.25H16.5z"></path>
                </g>
            </svg>
        </i>
        <a href="https://github.com/broadinstitute/genomeshader/issues" target="_blank">
            <i class="report-bug-icon">
                <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px" width="18" height="18" viewBox="0 -2 24 24">
                    <g transform="translate(0, 0)">
                        <path fill-rule="evenodd" d="M3.25 4a.25.25 0 00-.25.25v12.5c0 .138.112.25.25.25h2.5a.75.75 0 01.75.75v3.19l3.427-3.427A1.75 1.75 0 0111.164 17h9.586a.25.25 0 00.25-.25V4.25a.25.25 0 00-.25-.25H3.25zm-1.75.25c0-.966.784-1.75 1.75-1.75h17.5c.966 0 1.75.784 1.75 1.75v12.5a1.75 1.75 0 01-1.75 1.75h-9.586a.25.25 0 00-.177.073l-3.5 3.5A1.457 1.457 0 015 21.043V18.5H3.25a1.75 1.75 0 01-1.75-1.75V4.25zM12 6a.75.75 0 01.75.75v4a.75.75 0 01-1.5 0v-4A.75.75 0 0112 6zm0 9a1 1 0 100-2 1 1 0 000 2z"></path>
                    </g>
                </svg>
            </i>
        </a>
        <i class="gear-icon" onclick="alert('Not yet implemented.')">
            <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px" width="18" height="18" viewBox="0 0 24 24">
                <g transform="translate(0, 0)">
                    <path fill-rule="evenodd" d="M16 12a4 4 0 11-8 0 4 4 0 018 0zm-1.5 0a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0z"></path><path fill-rule="evenodd" d="M12 1c-.268 0-.534.01-.797.028-.763.055-1.345.617-1.512 1.304l-.352 1.45c-.02.078-.09.172-.225.22a8.45 8.45 0 00-.728.303c-.13.06-.246.044-.315.002l-1.274-.776c-.604-.368-1.412-.354-1.99.147-.403.348-.78.726-1.129 1.128-.5.579-.515 1.387-.147 1.99l.776 1.275c.042.069.059.185-.002.315-.112.237-.213.48-.302.728-.05.135-.143.206-.221.225l-1.45.352c-.687.167-1.249.749-1.304 1.512a11.149 11.149 0 000 1.594c.055.763.617 1.345 1.304 1.512l1.45.352c.078.02.172.09.22.225.09.248.191.491.303.729.06.129.044.245.002.314l-.776 1.274c-.368.604-.354 1.412.147 1.99.348.403.726.78 1.128 1.129.579.5 1.387.515 1.99.147l1.275-.776c.069-.042.185-.059.315.002.237.112.48.213.728.302.135.05.206.143.225.221l.352 1.45c.167.687.749 1.249 1.512 1.303a11.125 11.125 0 001.594 0c.763-.054 1.345-.616 1.512-1.303l.352-1.45c.02-.078.09-.172.225-.22.248-.09.491-.191.729-.303.129-.06.245-.044.314-.002l1.274.776c.604.368 1.412.354 1.99-.147.403-.348.78-.726 1.129-1.128.5-.579.515-1.387.147-1.99l-.776-1.275c-.042-.069-.059-.185.002-.315.112-.237.213-.48.302-.728.05-.135.143-.206.221-.225l1.45-.352c.687-.167 1.249-.749 1.303-1.512a11.125 11.125 0 000-1.594c-.054-.763-.616-1.345-1.303-1.512l-1.45-.352c-.078-.02-.172-.09-.22-.225a8.469 8.469 0 00-.303-.728c-.06-.13-.044-.246-.002-.315l.776-1.274c.368-.604.354-1.412-.147-1.99-.348-.403-.726-.78-1.128-1.129-.579-.5-1.387-.515-1.99-.147l-1.275.776c-.069.042-.185.059-.315-.002a8.465 8.465 0 00-.728-.302c-.135-.05-.206-.143-.225-.221l-.352-1.45c-.167-.687-.749-1.249-1.512-1.304A11.149 11.149 0 0012 1zm-.69 1.525a9.648 9.648 0 011.38 0c.055.004.135.05.162.16l.351 1.45c.153.628.626 1.08 1.173 1.278.205.074.405.157.6.249a1.832 1.832 0 001.733-.074l1.275-.776c.097-.06.186-.036.228 0 .348.302.674.628.976.976.036.042.06.13 0 .228l-.776 1.274a1.832 1.832 0 00-.074 1.734c.092.195.175.395.248.6.198.547.652 1.02 1.278 1.172l1.45.353c.111.026.157.106.161.161a9.653 9.653 0 010 1.38c-.004.055-.05.135-.16.162l-1.45.351a1.833 1.833 0 00-1.278 1.173 6.926 6.926 0 01-.25.6 1.832 1.832 0 00.075 1.733l.776 1.275c.06.097.036.186 0 .228a9.555 9.555 0 01-.976.976c-.042.036-.13.06-.228 0l-1.275-.776a1.832 1.832 0 00-1.733-.074 6.926 6.926 0 01-.6.248 1.833 1.833 0 00-1.172 1.278l-.353 1.45c-.026.111-.106.157-.161.161a9.653 9.653 0 01-1.38 0c-.055-.004-.135-.05-.162-.16l-.351-1.45a1.833 1.833 0 00-1.173-1.278 6.928 6.928 0 01-.6-.25 1.832 1.832 0 00-1.734.075l-1.274.776c-.097.06-.186.036-.228 0a9.56 9.56 0 01-.976-.976c-.036-.042-.06-.13 0-.228l.776-1.275a1.832 1.832 0 00.074-1.733 6.948 6.948 0 01-.249-.6 1.833 1.833 0 00-1.277-1.172l-1.45-.353c-.111-.026-.157-.106-.161-.161a9.648 9.648 0 010-1.38c.004-.055.05-.135.16-.162l1.45-.351a1.833 1.833 0 001.278-1.173 6.95 6.95 0 01.249-.6 1.832 1.832 0 00-.074-1.734l-.776-1.274c-.06-.097-.036-.186 0-.228.302-.348.628-.674.976-.976.042-.036.13-.06.228 0l1.274.776a1.832 1.832 0 001.734.074 6.95 6.95 0 01.6-.249 1.833 1.833 0 001.172-1.277l.353-1.45c.026-.111.106-.157.161-.161z"></path>
                </g>
            </svg>
        </i>
    </div>
</header>

<main style="width: 100%;">
<div class="tab-bar">
    <span class="tab-name">
        <i class="tab-viewer-icon">
            <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px" width="12" height="12" viewBox="0 -3 24 24">
                <g transform="translate(0, 0)">
                    <path fill="#ffffff" stroke="#ffffff" fill-rule="evenodd" d="M19.25 4.5H4.75a.25.25 0 00-.25.25v14.5c0 .138.112.25.25.25h.19l9.823-9.823a1.75 1.75 0 012.475 0l2.262 2.262V4.75a.25.25 0 00-.25-.25zm.25 9.56l-3.323-3.323a.25.25 0 00-.354 0L7.061 19.5H19.25a.25.25 0 00.25-.25v-5.19zM4.75 3A1.75 1.75 0 003 4.75v14.5c0 .966.784 1.75 1.75 1.75h14.5A1.75 1.75 0 0021 19.25V4.75A1.75 1.75 0 0019.25 3H4.75zM8.5 9.5a1 1 0 100-2 1 1 0 000 2zm0 1.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z"></path>
                </g>
            </svg>
        </i>
        Viewer
    </span>
</div>

<footer></footer>

</main>

<aside>
<div class="tab-bar">
    <span class="tab-name">
        <i class="tab-info-icon">
            <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px" width="12" height="12" viewBox="0 -3 24 24">
                <g transform="translate(0, 0)">
                    <path fill="#ffffff" stroke="#ffffff" fill-rule="evenodd" d="M0 4.75C0 3.784.784 3 1.75 3h20.5c.966 0 1.75.784 1.75 1.75v14.5A1.75 1.75 0 0122.25 21H1.75A1.75 1.75 0 010 19.25V4.75zm1.75-.25a.25.25 0 00-.25.25v14.5c0 .138.112.25.25.25h20.5a.25.25 0 00.25-.25V4.75a.25.25 0 00-.25-.25H1.75z"></path>
                    <path fill="#ffffff" stroke="#ffffff" fill-rule="evenodd" d="M5 8.75A.75.75 0 015.75 8h11.5a.75.75 0 010 1.5H5.75A.75.75 0 015 8.75zm0 4a.75.75 0 01.75-.75h5.5a.75.75 0 010 1.5h-5.5a.75.75 0 01-.75-.75z"></path>
                </g>
            </svg>
        </i>
        Information
    </span>
</div>
<div class="tab-content-info">
Hello
</div>
</aside>
        """

        inner_script = """
window.zoom = 0;

document.addEventListener('wheel', function(e) {
    window.zoom += e.deltaY;
});

function closeSidebar() {
    document.querySelector('.sidebar-icon-close').style.display = 'none';
    document.querySelector('.sidebar-icon-open').style.display = 'block';
    document.querySelector('aside').style.width = '0';
}

function openSidebar() {
    document.querySelector('.sidebar-icon-open').style.display = 'none';
    document.querySelector('.sidebar-icon-close').style.display = 'block';
    document.querySelector('aside').style.width = '300px';
}
        """

        inner_data = f"""
import pako from 'https://cdn.skypack.dev/pako@2.1.0';

function decompressEncodedData(encodedData) {{
    var compressedData = atob(encodedData);
    var bytes = new Uint8Array(compressedData.length);
    for (var i = 0; i < compressedData.length; i++) {{
        bytes[i] = compressedData.charCodeAt(i);
    }}
    return pako.inflate(bytes, {{ to: 'string' }});
}}

// Load data
window.data = JSON.parse({json.dumps(data_json)});

// Function to decode and parse the reference bases
window.encoded_ref = "{encoded_ref}";
window.data.ref = JSON.parse(decompressEncodedData(encoded_ref));

// Function to decode and parse the reads
window.encoded_samples = "{encoded_samples}";
window.data.samples = JSON.parse(decompressEncodedData(encoded_samples));
        """

        inner_module = """
import { Application, Graphics, Text, TextStyle, Color, Container, RenderTexture, Sprite, MSAA_QUALITY, Matrix } from 'https://cdn.skypack.dev/pixi.js@8.1.0';

// Some initial settings.
window.data.zoom = 0;

window.data.nucleotideColors = {
    'a': 0x45B29D, // Green
    'A': 0x45B29D, // Green
    'c': 0x334D5C, // Blue
    'C': 0x334D5C, // Blue
    'g': 0xE27A3F, // Yellow
    'G': 0xE27A3F, // Yellow
    't': 0xDF5A49, // Red
    'T': 0xDF5A49, // Red
    'n': 0xCCCCCC, // Grey (for unknown nucleotides)
    'N': 0xCCCCCC  // Grey (for unknown nucleotides)
};

// Create a PixiJS application.
const app = new Application();

// Function to initialize and render the PixiJS application.
async function renderApp() {
    // Get main HTMLElement.
    var main = document.querySelector('main');

    // Intialize the application.
    await app.init({
        antialias: false,
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
        backgroundColor: '#ffffff',
        resizeTo: main,
    });

    // Then adding the application's canvas to the DOM body.
    main.appendChild(app.canvas);

    window.data.locus_start = window.data.ref_start;
    window.data.locus_end = window.data.ref_end;

    // Set up element caches
    window.data.uiElements = {};
    window.data.sampleElements = {};

    // Listen for window resize events.
    window.addEventListener('resize', resize);

    repaint();
}

document.addEventListener('mousedown', function(event) {
    let startX = event.clientX;
    let startY = event.clientY;
    let startLocusStart = window.data.locus_start;
    let startLocusEnd = window.data.locus_end;

    document.body.style.cursor = 'grabbing';

    function onMouseMove(event) {
        let deltaX = event.clientX - startX;
        let deltaY = event.clientY - startY;

        const basesPerPixel = (startLocusEnd - startLocusStart) / document.querySelector('main').offsetHeight;

        window.data.locus_start = startLocusStart + (deltaY * basesPerPixel);
        window.data.locus_end = startLocusEnd + (deltaY * basesPerPixel);

        repaint();
    }

    function onMouseUp() {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);

        document.body.style.cursor = 'default';
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
});

document.addEventListener('wheel', function(event) {
    // Determine the zoom factor
    const zoomFactor = event.deltaY < 0 ? (event.shiftKey ? 0.99 : 0.9) : (event.shiftKey ? 1.01 : 1.1);

    // Calculate the new locus range based on the zoom factor
    const range = window.data.locus_end - window.data.locus_start;
    const newRange = range * zoomFactor;
    const center = (window.data.locus_start + window.data.locus_end) / 2;

    var locusStart = Math.round(center - newRange / 2);
    var locusEnd = Math.round(center + newRange / 2);

    // Ensure that the new range is within the reference range
    if (locusStart < window.data.ref_start) {
        locusStart = window.data.ref_start;
    }
    if (locusEnd > window.data.ref_end) {
        locusEnd = window.data.ref_end;
    }

    // If range is greater than the minimum range, allow the repaint to happen
    if (locusEnd - locusStart >= 10) {
        window.data.locus_start = locusStart;
        window.data.locus_end = locusEnd;

        // Redraw the screen contents
        repaint();
    }
});

document.addEventListener('mousemove', function(event) {
    var main = document.querySelector('main');

    const rect = main.getBoundingClientRect();
    const mouseY = event.clientY - rect.top;

    const basesPerPixel = (window.data.locus_end - window.data.locus_start) / (main.offsetHeight - 20 - 20 - 35);
    const locusY = window.data.locus_end - ((mouseY - 20) * basesPerPixel);

    var footer = document.querySelector('footer');
    if (footer) {
        footer.textContent = window.data.ref_chr + ":" + Math.round(locusY).toLocaleString();
    }
});

// Resize function window
function resize() {
    app.stage.removeChildren();

    window.data.uiElements = {};

    repaint();
}

// Resize function window
function repaint() {
    var main = document.querySelector('main');

    // Resize the renderer
    app.renderer.resize(main.offsetWidth, main.offsetHeight);

    // Draw all the elements
    drawIdeogram(main, window.data.ideogram);
    drawRuler(main);
    drawGenes(main, window.data.genes);
    drawReference(main, window.data.ref);
    drawSamples(main, window.data.samples);
}

// Function to draw the ideogram.
async function drawIdeogram(main, ideogramData) {
    if (!window.data.uiElements.hasOwnProperty('ideogram')) {
        const ideogram = new Graphics();

        const ideoLength = ideogramData.columns[2].values[ideogramData.columns[2].values.length - 1];
        const ideoWidth = 18;
        const ideoHeight = main.offsetHeight - 150;
        const ideoX = 15;
        const ideoY = 40;

        // Create a tooltip that appears when we hover over ideogram segments.
        ideogram.interactive = true;
        ideogram.buttonMode = true;

        const tooltip = new Text({
            text: '',
            style: {
                fontFamily: 'Helvetica',
                fontSize: 9,
                fill: 0x777777,
                align: 'center'
            }
        });

        tooltip.visible = false;
        app.stage.addChild(tooltip);

        ideogram.on('mousemove', (event) => {
            if (tooltip.visible) {
                tooltip.position.set(event.data.global.x + 10, event.data.global.y + 10);
            }
        });

        ideogram.on('mouseout', () => {
            tooltip.visible = false;
        });

        let bandY = ideoY;
        let acenSeen = false;
        for (let i = ideogramData.columns[0].values.length - 1; i >= 0; i--) {
            let bandHeight = (ideogramData.columns[2].values[i] - ideogramData.columns[1].values[i]) * ideoHeight / ideoLength;
            let bandStart = ideogramData.columns[1].values[i];
            let bandEnd = ideogramData.columns[2].values[i];
            let bandName = ideogramData.columns[3].values[i];
            let bandStain = ideogramData.columns[4].values[i];
            let bandColor = ideogramData.columns[5].values[i];

            const band = new Graphics();
            band.interactive = true;
            band.buttonMode = true;

            band.on('mouseover', () => {
                tooltip.text = bandStart + "-" + bandEnd;
                tooltip.visible = true;
            });

            band.on('mouseout', () => {
                tooltip.visible = false;
            });

            if (bandStain == 'acen') {
                // Draw centromere triangles

                const blank = new Graphics();
                blank.rect(ideoX, bandY, ideoWidth, bandHeight);
                blank.stroke({ width: 2, color: 0xffffff });
                blank.fill("#ffffff");
                ideogram.addChild(blank);

                if (!acenSeen) {
                    band.moveTo(ideoX, bandY);
                    band.lineTo(ideoX + ideoWidth - 0.5, bandY);
                    band.lineTo(ideoX + (ideoWidth / 2), bandY + bandHeight);
                    band.lineTo(ideoX, bandY);
                } else {
                    band.moveTo(ideoX, bandY + bandHeight);
                    band.lineTo(ideoX + ideoWidth - 0.5, bandY + bandHeight);
                    band.lineTo(ideoX + (ideoWidth / 2), bandY);
                    band.lineTo(ideoX, bandY + bandHeight);
                }

                band.stroke({ width: 2, color: bandColor });
                band.fill(bandColor);
                acenSeen = true;
            } else {
                // Draw non-centromeric rectangles

                band.rect(ideoX, bandY, ideoWidth, bandHeight);
                band.stroke({ width: 0, color: 0x333333 });
                band.fill(bandColor);

                function invertColor(hex) {
                    // If the color is in hex format (e.g., #FFFFFF), remove the hash
                    if (hex.indexOf('#') === 0) {
                        hex = hex.slice(1);
                    }

                    // If the color is in shorthand hex format (e.g., #FFF), convert to full format
                    if (hex.length === 3) {
                        hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
                    }

                    // Convert the hex color to its RGB components
                    var r = parseInt(hex.slice(0, 2), 16),
                        g = parseInt(hex.slice(2, 4), 16),
                        b = parseInt(hex.slice(4, 6), 16);

                    // Invert each component by subtracting it from 255
                    r = (255 - r).toString(16);
                    g = (255 - g).toString(16);
                    b = (255 - b).toString(16);

                    // Ensure each inverted component has two digits
                    r = r.length === 1 ? '0' + r : r;
                    g = g.length === 1 ? '0' + g : g;
                    b = b.length === 1 ? '0' + b : b;

                    // Return the inverted color in hex format
                    return '#' + r + g + b;
                }

                const bandLabel = new Text({
                    text: bandName,
                    style: {
                        fontFamily: 'Helvetica',
                        fontSize: 7,
                        fill: invertColor(bandColor),
                        align: 'center'
                    }
                });

                bandLabel.rotation = -Math.PI / 2;
                bandLabel.x = ideoX + bandLabel.height / 2;
                bandLabel.y = bandY + bandHeight / 2 + bandLabel.width / 2;

                if (bandLabel.width <= 0.9*bandHeight) {
                    band.addChild(bandLabel);
                }
            }

            ideogram.addChild(band);
            bandY += bandHeight;
        }

        // Draw outer rectangle of ideogram
        ideogram.rect(ideoX, ideoY, ideoWidth, ideoHeight);
        ideogram.stroke({ width: 2, color: 0x333333 });
        ideogram.fill(0xffffff);

        app.stage.addChild(ideogram);

        // Draw chromosome name
        const chrText = new Text({
            text: ideogramData.columns[0].values[0],
            style: {
                fontFamily: 'Helvetica',
                fontSize: 12,
                fill: 0x000000,
                align: 'center',
            }
        });

        chrText.x = 17;
        chrText.y = main.offsetHeight - 70;
        chrText.rotation = - Math.PI / 2;

        app.stage.addChild(chrText);

        // Draw selected region
        const selectionY = (ideoLength - window.data.locus_end) * ideoHeight / ideoLength;
        const selectionHeight = (window.data.locus_end - window.data.locus_start) * ideoHeight / ideoLength;

        const selection = new Graphics();
        selection.rect(ideoX - 5, ideoY + selectionY, ideoWidth + 10, selectionHeight < 3 ? 3 : selectionHeight);
        selection.fill("#ff000055");
        ideogram.addChild(selection);

        window.data.uiElements['ideogram'] = ideogram;
    }
}

async function drawRuler(main) {
    if (window.data.uiElements.hasOwnProperty('ruler')) {
        window.data.uiElements['ruler'].destroy();
    }

    const ruler = new Graphics();

    // Draw axis line
    let axisY = 20;
    let axisHeight = main.offsetHeight - axisY - 35;

    ruler.stroke({ width: 1.0, color: 0x555555 });
    ruler.moveTo(105, axisY);
    ruler.lineTo(105, axisHeight);

    app.stage.addChild(ruler);

    // Display range
    const locusTextRange = new Text({
        text: "(" + Math.floor(window.data.locus_end - window.data.locus_start).toLocaleString() + " bp)",
        style: {
            fontFamily: 'Helvetica',
            fontSize: 9,
            fill: 0x000000,
            align: 'center',

        },
        x: 108,
        y: axisY + (axisHeight/2),
    });
    locusTextRange.rotation = - Math.PI / 2;

    ruler.addChild(locusTextRange);

    // Compute tics at various points
    const range = window.data.locus_end - window.data.locus_start;
    const maxTics = 20;

    // Start with an increment that is an order of magnitude smaller than the range
    let ticIncrement = Math.pow(10, Math.floor(Math.log10(range)) - 1);

    // Adjust the increment to end in 0 or 5 and to have a reasonable number of tics
    while (true) {
        if (range / ticIncrement <= maxTics) {
            if (ticIncrement % 10 === 0 || ticIncrement % 10 === 5) {
                break;
            } else if ((ticIncrement + 5) % 10 === 0) {
                ticIncrement += 5; // Adjust to end in 0
            } else {
                ticIncrement = Math.ceil(ticIncrement / 10) * 10; // Round up to the next multiple of 10
            }
        } else {
            ticIncrement *= 2; // Double the increment to reduce the number of tics
        }
    }

    // Generate the tics
    let currentTic = window.data.locus_start - (window.data.locus_start % ticIncrement) + ticIncrement;
    while (currentTic < window.data.locus_end) {
        let basesPerPixel = (window.data.locus_end - window.data.locus_start) / (axisHeight - axisY);
        let ticPositionY = (window.data.locus_end - currentTic) / basesPerPixel;

        if (ticPositionY >= axisY && ticPositionY <= axisHeight) {
            ruler.stroke({ width: 1.0, color: 0x555555 });
            ruler.moveTo(102, ticPositionY);
            ruler.lineTo(108, ticPositionY);

            const locusText = new Text({
                text: currentTic.toLocaleString(),
                style: {
                    fontFamily: 'Helvetica',
                    fontSize: 9,
                    fill: 0x000000,
                    align: 'right',
                },
                x: 52,
                y: ticPositionY - 5.5
            });

            ruler.addChild(locusText);
        }

        currentTic += ticIncrement;
    }

    window.data.uiElements['ruler'] = ruler;
}

async function drawGenes(main, geneData) {
    if (window.data.uiElements.hasOwnProperty('genes')) {
        window.data.uiElements['genes'].destroy();
    }

    const genes = new Graphics();

    const basesPerPixel = (window.data.locus_end - window.data.locus_start) / (main.offsetHeight - 20 - 20 - 35);

    for (let geneIdx = 0; geneIdx < geneData.columns[0].values.length; geneIdx++) {
        let txStart = geneData.columns[4].values[geneIdx];
        let txEnd = geneData.columns[5].values[geneIdx];
        let geneName = geneData.columns[12].values[geneIdx];
        let geneStrand = geneData.columns[3].values[geneIdx];

        let geneBarEnd = (window.data.locus_end - txEnd) / basesPerPixel
        let geneBarStart = (window.data.locus_end - txStart) / basesPerPixel

        // Draw gene line
        genes.moveTo(130, geneBarEnd);
        genes.lineTo(130, geneBarStart);
        genes.stroke({ width: 1, color: 0x0000ff });

        // Draw strand lines
        for (let txPos = txStart + 200; txPos <= txEnd - 200; txPos += 500) {
            let feathersY = (window.data.locus_end - txPos) / basesPerPixel;

            genes.moveTo(130, feathersY);
            genes.lineTo(127, geneStrand == '+' ? feathersY+5 : txPos-5);
            genes.stroke({ width: 1, color: 0x0000ff });

            genes.moveTo(130, feathersY);
            genes.lineTo(133, geneStrand == '+' ? feathersY+5 : txPos-5);
            genes.stroke({ width: 1, color: 0x0000ff });
        }

        // Draw gene name
        const geneNameLabel = new Text({
            text: geneName,
            style: {
                fontFamily: 'Helvetica',
                fontSize: 9,
                fill: 0x000000,
                align: 'center',
            },
            x: 130 + 3,
            y: geneBarEnd + (Math.abs(geneBarEnd - geneBarStart) / 2)
        });
        geneNameLabel.rotation = - Math.PI / 2;

        genes.addChild(geneNameLabel);

        // Draw exons
        let exonStarts = geneData.columns[9].values[geneIdx].split(',').filter(Boolean);
        let exonEnds = geneData.columns[10].values[geneIdx].split(',').filter(Boolean);

        for (let exonIdx = 0; exonIdx < exonStarts.length; exonIdx++) {
            const exonEndY = (window.data.locus_end - exonEnds[exonIdx]) / basesPerPixel;
            const exonStartY = (window.data.locus_end - exonStarts[exonIdx]) / basesPerPixel;

            genes.rect(130 - 5, exonEndY, 10, Math.abs(exonEndY - exonStartY));
            genes.stroke({ width: 2, color: 0x0000ff });
            genes.fill(0xff);
        }
    }

    app.stage.addChild(genes);

    window.data.uiElements['genes'] = genes;
}

async function drawReference(main, refData) {
    if (window.data.uiElements.hasOwnProperty('reference')) {
        window.data.uiElements['reference'].destroy();
    }

    const reference = new Graphics();

    const basesPerPixel = (window.data.locus_end - window.data.locus_start) / (main.offsetHeight - 20 - 20 - 35);
    const halfBaseHeight = 0.5 / basesPerPixel;

    const nucleotideColors = window.data.nucleotideColors;

    for (let locusPos = window.data.ref_start + 1, i = 0; locusPos <= window.data.ref_end; locusPos++, i++) {
        if (window.data.locus_end - window.data.locus_start <= 1500 && window.data.locus_start <= locusPos && locusPos <= window.data.locus_end) {
            const base = refData.columns[0].values[i];
            const baseColor = nucleotideColors[base];

            const refY = (window.data.locus_end - locusPos) / basesPerPixel;

            if (window.data.locus_end - window.data.locus_start <= 100) {
                const baseLabel = new Text({
                    text: base,
                    style: {
                        fontFamily: 'Helvetica',
                        fontSize: 10,
                        fontWeight: 'bold',
                        fill: baseColor,
                        align: 'center',
                    },
                    x: 154,
                    y: refY
                });
                baseLabel.rotation = - Math.PI / 2;

                reference.addChild(baseLabel);
            } else {
                let refBase = new Graphics();
                refBase.rect(154, refY - halfBaseHeight, 10, 2*halfBaseHeight);
                refBase.fill({ fill: baseColor });

                reference.addChild(refBase);
            }
        }
    }

    app.stage.addChild(reference);

    window.data.uiElements['reference'] = reference;
}

async function drawSamples(main, sampleData) {
    const graphics = new Graphics();

    const sampleDict = {};
    let index = 0;
    for (const sampleName of window.data.samples.columns[9].values) {
        if (!sampleDict.hasOwnProperty(sampleName)) {
            sampleDict[sampleName] = index++;
        }
    }

    for (const [sampleName, sampleIndex] of Object.entries(sampleDict)) {
        drawSample(main, sampleData, sampleName, sampleIndex);
    }
}

async function drawSample(main, sampleData, sampleName, sampleIndex, sampleWidth=20) {
    const basesPerPixel = (window.data.locus_end - window.data.locus_start) / (main.offsetHeight - 20 - 20 - 35);
    const halfBaseHeight = 0.5 / basesPerPixel;

    let sampleTrack;
    if (!window.data.uiElements.hasOwnProperty['sampleContainer-' + sampleName]) {
        const sampleContainer = new Container({
            isRenderGroup: true,
            cullable: true,
            cullableChildren: true,
            x: 185 + (sampleIndex*sampleWidth),
            y: 0,
        });

        sampleTrack = new Graphics();
        sampleTrack.rect(0, 0, sampleWidth - 5, document.querySelector('main').offsetHeight);
        sampleTrack.stroke({ width: 1, color: 0xaaaaaa });
        sampleTrack.fill(0xdddddd);

        sampleTrack.interactive = true;
        sampleTrack.buttonMode = true;

        sampleContainer.addChild(sampleTrack);
        app.stage.addChild(sampleContainer);

        window.data.uiElements['sampleContainer-' + sampleName] = sampleContainer;
        window.data.uiElements['sampleTrack-' + sampleName] = sampleTrack;
    } else {
        sampleTrack = window.data.uiElements['sampleTrack-' + sampleName];
    }

    if (!window.data.sampleElements.hasOwnProperty(sampleName)) {
        window.data.sampleElements[sampleName] = new Map();
    }

    let elementCache = window.data.sampleElements[sampleName];

    if (elementCache.size == 0) {
        for (let i = 0; i < sampleData.columns[10].values.length; i++) {
            let referenceStart = sampleData.columns[3].values[i];
            let referenceEnd = sampleData.columns[4].values[i];
            let rowSampleName = sampleData.columns[9].values[i];
            let elementType = sampleData.columns[10].values[i];
            let sequence = sampleData.columns[11].values[i];

            const elementKey = `${referenceStart}-${referenceEnd}-${rowSampleName}-${elementType}-${sequence}`;

            if (sampleName == rowSampleName && !(referenceEnd < window.data.locus_start || referenceStart > window.data.locus_end)) {
                if (!elementCache.has(elementKey)) {
                    const elementY = (window.data.locus_end - referenceStart) / basesPerPixel;
                    const elementHeight = Math.ceil(Math.abs(elementY - ((window.data.locus_end - referenceEnd) / basesPerPixel)));

                    let cigarElement = new Graphics();
                    cigarElement.referenceStart = referenceStart;
                    cigarElement.referenceEnd = referenceEnd;
                    cigarElement.cullable = true;

                    // see alignment.rs for ElementType mapping
                    if (elementType == 1) { // mismatch
                        let color = window.data.nucleotideColors.hasOwnProperty(sequence) ? window.data.nucleotideColors[sequence] : null;

                        cigarElement.rect(0, elementY - halfBaseHeight, sampleWidth - 5, elementHeight);
                        if (color !== null) { cigarElement.fill({ color: color, alpha: 0.1 }); }

                        cigarElement.interactive = true;
                        cigarElement.on('mouseover', () => {
                            console.log(cigarElement.fillStyle);
                            console.log(cigarElement.referenceStart);
                        });

                        elementCache.set(elementKey, [cigarElement]);
                    } else if (elementType == 2) { // insertion
                        cigarElement.rect(0, elementY - (1.5*halfBaseHeight), sampleWidth - 5, (0.5*halfBaseHeight));
                        cigarElement.fill({ fill: "#800080", alpha: 0.1 });

                        elementCache.set(elementKey, [cigarElement]);
                    } else if (elementType == 3) { // deletion
                        cigarElement.rect(0, elementY - halfBaseHeight, sampleWidth - 5, elementHeight);
                        cigarElement.fill({ fill: "#ffffff", alpha: 0.1 });

                        let deletionBar = new Graphics();
                        deletionBar.rect(4, elementY - halfBaseHeight, 2, elementHeight);
                        deletionBar.fill({ fill: "#000000", alpha: 0.1});
                        deletionBar.referenceStart = referenceStart;
                        deletionBar.referenceEnd = referenceEnd;
                        deletionBar.cullable = true;

                        elementCache.set(elementKey, [cigarElement, deletionBar]);
                    }
                } else {
                    let elements = elementCache.get(elementKey);
                    elements.forEach((element) => {
                        element.fillStyle.alpha = Math.min(element.fillStyle.alpha + 0.1, 1.0);
                    });
                }
            }
        }
    }

    let reported = false;
    elementCache.forEach((elements) => {
        elements.forEach((element) => {
            // The element overlaps with the visible interval
            const elementY = (window.data.locus_end - element.referenceStart) / basesPerPixel;
            const elementHeight = Math.ceil(Math.abs(elementY - ((window.data.locus_end - element.referenceEnd) / basesPerPixel)));

            // element.visible = true;
            element.y = elementY;
            element.height = elementHeight;

            sampleTrack.addChild(element);
        });
    });
}

// Call the function initially
renderApp();
        """

        # Safely encode the JavaScript string for HTML embedding
        encoded_style = json.dumps(inner_style)
        encoded_body = json.dumps(inner_body)
        encoded_script = json.dumps(inner_script)
        encoded_data = json.dumps(inner_data)
        encoded_module = json.dumps(inner_module)

        # Use the encoded script in the HTML template
        html_script = f"""
<script>
(async function() {{
    var width = 0.8 * window.screen.width;
    var height = 0.65 * window.screen.height;
    var newWindow = window.open("", "newWindow", "width=" + width + ",height=" + height + ",scrollbars=no,menubar=no,toolbar=no,status=no");
    if (!newWindow) return;

    // Set the title of the new window
    newWindow.document.title = "genomeshader";
    newWindow.document.body.innerHTML = {encoded_body};
    
    // Append a style tag
    var style = document.createElement('style');
    style.innerHTML = {encoded_style};
    
    newWindow.document.head.appendChild(style);
    
    // Append UI helper script
    var script = document.createElement('script');
    script.innerHTML = {encoded_script};
    
    newWindow.document.body.appendChild(script);

    // Append compressed data module
    var data = document.createElement('script');    
    data.type = "module";
    data.defer = true;
    data.innerHTML = {encoded_data};

    newWindow.document.body.appendChild(data);
                    
    // Append app module
    var module = document.createElement('script');    
    module.type = "module";
    module.defer = true;
    module.innerHTML = {encoded_module};
    
    newWindow.document.body.appendChild(module);
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

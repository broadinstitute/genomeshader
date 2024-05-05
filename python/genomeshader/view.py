import os
import re
from enum import Enum
from typing import Union, List

import requests
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

    def show_old(
        self,
        locus_or_dataframe: Union[str, pl.DataFrame],
        width: int = 1000,
        height: int = 1000,
        vertical: bool = False,
        expand: bool = False,
        group_by: str = None,
    ):
        """
        Visualizes genomic data.

        Args:
            locus_or_dataframe (str or DataFrame): Genomic locus to visualize.
            Can either be specified as a locus string (e.g. 'chr:start-stop')
            or a Polars DataFrame (usually from the get_locus() method,
            optionally modified by the user).
            width (int, optional): Visualization width. Defaults to 980.
            height (int, optional): Visualization height. Defaults to 400.
            expand (bool, optional): If True, expands each sample to show all
            reads. Defaults to False.
        """

        if isinstance(locus_or_dataframe, str):
            df = self.get_locus(locus_or_dataframe)
        elif isinstance(locus_or_dataframe, pl.DataFrame):
            df = locus_or_dataframe.clone()
        else:
            raise ValueError(
                "locus_or_dataframe must be a locus string or a" "Polars DataFrame."
            )

        ref_chr = df["reference_contig"].min()
        ref_start = df["reference_start"].min()
        ref_end = df["reference_end"].max()

        locus = f"{ref_chr}:{ref_start}-{ref_end}"

        pieces = re.split("[:-]", re.sub(",", "", locus))

        chrom = pieces[0]
        start = int(pieces[1])
        stop = int(pieces[2]) if len(pieces) > 2 else start

        df = df.filter(pl.col("element_type") != 0)

        if group_by is not None:
            df = df.sort(pl.col(group_by))

        sample_names = []
        group_names = []
        y0s = []
        y0 = 0
        if not expand:
            sample_name = None
            group_name = None
            for row in df.iter_rows(named=True):
                if sample_name is None:
                    sample_name = row["sample_name"]
                    group_name = row[group_by] if group_by is not None else ""
                    sample_names.append(sample_name)
                    group_names.append(group_name)
                    y0 = 0

                if sample_name != row["sample_name"]:
                    if group_by and group_name != row[group_by]:
                        group_name = row[group_by]
                        sample_names.append("")
                        group_names.append("")
                        group_names.append(group_name)
                        y0 += 1
                    else:
                        group_names.append("")

                    sample_name = row["sample_name"]
                    sample_names.append(sample_name)
                    y0 += 1


                y0s.append(y0)
        else:
            query_name = None
            for row in df.iter_rows(named=True):
                if query_name is None:
                    query_name = row["query_name"]
                    y0 = 0

                if query_name != row["query_name"]:
                    query_name = row["query_name"]
                    y0 += 1

                y0s.append(y0)

        # Position all of the read and cigar elements, and color-code them
        df = df.with_columns(pl.Series(name="read_num", values=y0s))

        h1 = 0.9
        df = df.with_columns(pl.col("read_num").alias("y0") * -1 - h1 / 2)
        df = df.with_columns(pl.col("read_num").alias("y1") * -1 + h1 / 2)

        df = df.with_columns(
            pl.when(df["element_type"] == 0)
            .then(pl.lit("#CCCCCC"))
            .when((df["element_type"] == 1) & (df["sequence"] == "A"))
            .then(pl.lit("#00F10010"))
            .when((df["element_type"] == 1) & (df["sequence"] == "C"))
            .then(pl.lit("#341BFF10"))
            .when((df["element_type"] == 1) & (df["sequence"] == "G"))
            .then(pl.lit("#D37D2810"))
            .when((df["element_type"] == 1) & (df["sequence"] == "T"))
            .then(pl.lit("#FF003010"))
            .when(df["element_type"] == 2)
            .then(pl.lit("#7618DC10"))
            .when(df["element_type"] == 3)
            .then(pl.lit("#FFFFFF10"))
            .when((df["element_type"] == 4) & (df["sequence"] == "A"))
            .then(pl.lit("#00F10000"))
            .when((df["element_type"] == 4) & (df["sequence"] == "C"))
            .then(pl.lit("#341BFF00"))
            .when((df["element_type"] == 4) & (df["sequence"] == "G"))
            .then(pl.lit("#D37D2800"))
            .when((df["element_type"] == 4) & (df["sequence"] == "T"))
            .then(pl.lit("#FF003000"))
            .otherwise(pl.lit("#00000010"))
            .alias("color")
        )

        # Add a line to show deletions more clearly
        h2 = 0.1
        df_extra = (
            df.filter(df["element_type"] == 3)
            .with_columns(pl.col("read_num").alias("y0") * -1 - h2 / 2)
            .with_columns(pl.col("read_num").alias("y1") * -1 + h2 / 2)
            .with_columns(pl.lit("#00000010").alias("color"))
        )
        df = df.vstack(df_extra)

        # Add a column to account for column max width
        df = df.with_columns(
            pl.col("reference_start").alias("reference_end_padded")
            + pl.col("column_width")
        )

        # Get sample names
        samples_df = (
            df.group_by("sample_name")
            .first()
            .drop(
                [
                    "reference_contig",
                    "is_forward",
                    "query_name",
                    "read_group",
                    "element_type",
                    "sequence",
                    "color",
                    "read_num",
                    "y1",
                ]
            )
            .sort("y0", descending=True)
        )

        # tooltips = [
        #     ('Sample Name', '@sample_name')
        # ]
        # hover = HoverTool(tooltips=tooltips)

        ideo = self.ideogram("hg38")
        ideo = ideo.filter(pl.col("chrom") == chrom)
        ideo = ideo.select(["start", "y0", "end", "y1", "color"])
        ideo = ideo.vstack(
            pl.DataFrame(
                {
                    "start": [start],
                    "y0": [ideo["y0"][0] - 0.15],
                    "end": [stop],
                    "y1": [ideo["y1"][0] + 0.15],
                    "color": ["#cc0000"],
                }
            )
        )

        # genes_df = pl.read_csv(
        #     f'
        #     separator="\t",
        # )
        # genes_df = genes_df.filter(
        #     (pl.col("chrom") == chrom)
        #     & (pl.col("txStart") <= stop)
        #     & (pl.col("txEnd") >= start)
        # )
        # genes_df = genes_df.with_columns(
        #     [
        #         pl.col("txStart").alias("reference_start"),
        #         pl.col("txEnd").alias("reference_end"),
        #         pl.lit(0.4).alias("y0"),
        #         pl.lit(0.6).alias("y1"),
        #     ]
        # )

        # exons_df = (
        #     genes_df.with_columns(
        #         [
        #             pl.col("exonStarts").str.split(",").alias("reference_start"),
        #             pl.col("exonEnds").str.split(",").alias("reference_end"),
        #         ]
        #     )
        #     .explode(["reference_start", "reference_end"])
        #     .filter(pl.col("reference_start") != "")
        #     .with_columns(
        #         [
        #             pl.col("reference_start").cast(pl.Int64).alias("reference_start"),
        #             pl.col("reference_end").cast(pl.Int64).alias("reference_end"),
        #             pl.lit(0.0).alias("y0"),
        #             pl.lit(1.0).alias("y1"),
        #         ]
        #     )
        # )

        # genes_exons_df = genes_df.vstack(exons_df)

    def show(
        self,
        locus_or_dataframe: Union[str, pl.DataFrame],
        horizontal: bool = False,
        group_by: str = None,
    ):
        """
        Visualizes genomic data by rendering a graphical representation of a genomic locus.

        Parameters:
            locus_or_dataframe (Union[str, pl.DataFrame]): The genomic locus to visualize, which can be specified as either:
                - A string representing the locus in the format 'chromosome:start-stop' (e.g., 'chr1:1000000-2000000').
                - A Polars DataFrame containing genomic data, which can be obtained from the `get_locus()` method or created by the user.
            horizontal (bool, optional): If set to True, the visualization will be rendered horizontally. Defaults to False.
            group_by (str, optional): The name of the column to group data by in the visualization. Defaults to None.

        Returns:
            None: This method does not return a value; it renders the visualization directly.
        """

        if isinstance(locus_or_dataframe, str):
            reads_df = self.get_locus(locus_or_dataframe)
        elif isinstance(locus_or_dataframe, pl.DataFrame):
            reads_df = locus_or_dataframe.clone()
        else:
            raise ValueError(
                "locus_or_dataframe must be a locus string or a Polars DataFrame."
            )

        ref_chr = reads_df["reference_contig"].min()
        ref_start = reads_df["reference_start"].min()
        ref_end = reads_df["reference_end"].max()

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
        compressed_reads = gzip.compress(reads_df.write_json().encode('utf-8'))
        compressed_ref = gzip.compress(ref_json.encode('utf-8'))

        # Encode compressed data to base64 to embed in HTML safely
        encoded_reads = base64.b64encode(compressed_reads).decode('utf-8')
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

// Function to decode and parse the JSON
const encoded_reads = "{encoded_reads}";
const encoded_ref = "{encoded_ref}";

window.data.reads = JSON.parse(decompressEncodedData(encoded_reads));
window.data.ref = JSON.parse(decompressEncodedData(encoded_ref));
        """

        inner_module = """
import { Application, Graphics, Text, TextStyle, Color } from 'https://cdn.skypack.dev/pixi.js@8.1.0';

// Some initial settings.
window.data.zoom = 0;

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

    // Listen for window resize events.
    window.addEventListener('resize', repaint);

    repaint();
}

document.addEventListener('mousedown', function(event) {
    let startX = event.clientX;
    let startY = event.clientY;
    let startLocusStart = window.data.locus_start;
    let startLocusEnd = window.data.locus_end;

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

    var locusStart = center - newRange / 2;
    var locusEnd = center + newRange / 2;

    // Ensure that the new range is within the reference range
    if (locusStart < window.data.ref_start) {
        locusStart = window.data.ref_start;
    }
    if (locusEnd > window.data.ref_end) {
        locusEnd = window.data.ref_end;
    }

    // If range is greater than the minimum range, allow the repaint to happen
    if (locusEnd - locusStart >= 20) {
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
function repaint() {
    var main = document.querySelector('main');

	// Resize the renderer
	app.renderer.resize(main.offsetWidth, main.offsetHeight);

    // Clear the application stage
    app.stage.removeChildren();

    // Draw all the elements
    drawIdeogram(main, window.data.ideogram);
    drawRuler(main);
    drawGenes(main, window.data.genes);
}

// Function to draw the ideogram.
async function drawIdeogram(main, ideogramData) {
    const graphics = new Graphics();

    const ideoLength = ideogramData.columns[2].values[ideogramData.columns[2].values.length - 1];
    const ideoWidth = 18;
    const ideoHeight = main.offsetHeight - 150;
    const ideoX = 15;
    const ideoY = 40;

    // Create a tooltip that appears when we hover over ideogram segments.
    graphics.interactive = true;
    graphics.buttonMode = true;

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

    graphics.on('mousemove', (event) => {
        if (tooltip.visible) {
            tooltip.position.set(event.data.global.x + 10, event.data.global.y + 10);
        }
    });

    graphics.on('mouseout', () => {
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
            graphics.addChild(blank);

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

            band.stroke({ width: 1, color: 0x333333 });
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

        graphics.addChild(band);
        bandY += bandHeight;
    }

    // Draw outer rectangle of ideogram
    graphics.rect(ideoX, ideoY, ideoWidth, ideoHeight);
    graphics.stroke({ width: 2, color: 0x333333 });
    graphics.fill(0xffffff);

    app.stage.addChild(graphics);

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
    graphics.addChild(selection);
}

async function drawRuler(main) {
    const graphics = new Graphics();

    // Draw axis line
    let axisY = 20;
    let axisHeight = main.offsetHeight - axisY - 35;

    graphics.setStrokeStyle(1.0, 0x555555);
    graphics.moveTo(105, axisY);
    graphics.lineTo(105, axisHeight);
    graphics.endFill();

    app.stage.addChild(graphics);

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

    app.stage.addChild(locusTextRange);

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
            graphics.setStrokeStyle(1.0, 0x555555);
            graphics.moveTo(102, ticPositionY);
            graphics.lineTo(108, ticPositionY);
            graphics.endFill();

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

            app.stage.addChild(locusText);
        }

        currentTic += ticIncrement;
    }
}

async function drawGenes(main, geneData) {
    const graphics = new Graphics();

    const basesPerPixel = (window.data.locus_end - window.data.locus_start) / (main.offsetHeight - 20 - 20 - 35);

    for (let geneIdx = 0; geneIdx < geneData.columns[0].values.length; geneIdx++) {
        let txStart = geneData.columns[4].values[geneIdx];
        let txEnd = geneData.columns[5].values[geneIdx];
        let geneName = geneData.columns[12].values[geneIdx];
        let geneStrand = geneData.columns[3].values[geneIdx];

        let geneBarEnd = (window.data.locus_end - txEnd) / basesPerPixel
        let geneBarStart = (window.data.locus_end - txStart) / basesPerPixel

        // Draw gene line
        graphics.moveTo(130, geneBarEnd);
        graphics.lineTo(130, geneBarStart);
        graphics.stroke({ width: 1, color: 0x0000ff });

        // Draw strand lines
        for (let txPos = txStart + 200; txPos <= txEnd - 200; txPos += 500) {
            let feathersY = (window.data.locus_end - txPos) / basesPerPixel;

            graphics.moveTo(130, feathersY);
            graphics.lineTo(127, geneStrand == '+' ? feathersY+5 : txPos-5);
            graphics.stroke({ width: 1, color: 0x0000ff });

            graphics.moveTo(130, feathersY);
            graphics.lineTo(133, geneStrand == '+' ? feathersY+5 : txPos-5);
            graphics.stroke({ width: 1, color: 0x0000ff });
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

        app.stage.addChild(geneNameLabel);

        let exonStarts = geneData.columns[9].values[geneIdx].split(',').filter(Boolean);
        let exonEnds = geneData.columns[10].values[geneIdx].split(',').filter(Boolean);

        for (let exonIdx = 0; exonIdx < exonStarts.length; exonIdx++) {
            const exonEndY = (window.data.locus_end - exonEnds[exonIdx]) / basesPerPixel;
            const exonStartY = (window.data.locus_end - exonStarts[exonIdx]) / basesPerPixel;

            graphics.rect(130 - 5, exonEndY, 10, Math.abs(exonEndY - exonStartY));
            graphics.stroke({ width: 2, color: 0x0000ff });
            graphics.fill(0xff);
        }
    }

    app.stage.addChild(graphics);
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

        # Display the HTML and JavaScript
        display(HTML(html_script))

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

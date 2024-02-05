import os
import re
from enum import Enum
from typing import Union, List

import polars as pl

# import datashader as ds
# import datashader.transfer_functions as tf

import holoviews as hv
from holoviews import opts

# import holoviews.operation.datashader as hd
from holoviews.plotting.links import RangeToolLink

from bokeh.models.formatters import BasicTickFormatter

# from bokeh.models import HoverTool
from bokeh.resources import INLINE
import bokeh.io

# from bokeh import *

import genomeshader.genomeshader as gs

hv.extension("bokeh")
hv.output(backend="bokeh")

bokeh.io.output_notebook(INLINE)

base_colors = {
    "A": "#00F100",
    "C": "#341BFF",
    "G": "#D37D2B",
    "T": "#FF0030",
    "N": "#CCCCCC",
}


class GenomeBuild(Enum):
    GRCh38 = "GRCh38"
    chm13v2_0 = "chm13v2.0"


class GenomeShader:
    def __init__(self, session_name: str = None, gcs_session_dir: str = None):
        self._validate_session_name(session_name)
        self.session_name = session_name

        if gcs_session_dir is None:
            if "GOOGLE_BUCKET" in os.environ:
                bucket = os.environ["GOOGLE_BUCKET"]
                gcs_session_dir = f"{bucket}/GenomeShader/{session_name}"
            else:
                raise ValueError(
                    "gcs_session_dir is None and "
                    "GOOGLE_BUCKET is not set in environment variables"
                )

        self._validate_gcs_session_dir(gcs_session_dir)
        self.gcs_session_dir = gcs_session_dir

        self._session = gs._init()

    def _validate_gcs_session_dir(self, gcs_session_dir: str):
        gcs_pattern = re.compile(
            r"^gs://[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]/"  # bucket
            r"([^/]+/)*"  # folders (optional)
            r"[^/]*$"  # file (optional)
        )

        if not gcs_pattern.match(gcs_session_dir):
            raise ValueError("Invalid GCS path")

    def _validate_session_name(self, session_name: str):
        session_pattern = re.compile("^[a-zA-Z0-9_]+$")

        if not session_pattern.match(session_name):
            raise ValueError("session_name contains special characters or whitespace")

    def __str__(self):
        return (
            f"GenomeShader:\n"
            f" - session_name: {self.session_name}\n"
            f" - gcs_session_dir: {self.gcs_session_dir}\n"
            f" - genome_build: {self.genome_build}\n"
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
        genome: GenomeBuild = GenomeBuild.GRCh38,
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
            genome (GenomeBuild, optional): The reference genome build to use
                for the reads. Defaults to GenomeBuild.GRCh38.
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

    def show(
        self,
        locus_or_dataframe: Union[str, pl.DataFrame],
        width: int = 1000,
        height: int = 1000,
        vertical: bool = False,
        expand: bool = False,
    ) -> hv.Rectangles:
        """
        Visualizes genomic data in a HoloViz interactive widget.

        Args:
            locus_or_dataframe (str or DataFrame): Genomic locus to visualize.
            Can either be specified as a locus string (e.g. 'chr:start-stop')
            or a Polars DataFrame (usually from the get_locus() method,
            optionally modified by the user).
            width (int, optional): Visualization width. Defaults to 980.
            height (int, optional): Visualization height. Defaults to 400.
            expand (bool, optional): If True, expands each sample to show all
            reads. Defaults to False.

        Returns:
            hv.Rectangles: HoloViews Rectangles object for visualization.
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

        chr = pieces[0]
        start = int(pieces[1])
        stop = int(pieces[2]) if len(pieces) > 2 else start

        df = df.sort(["sample_name", "query_name", "reference_start"])

        adf = df.filter(df["element_type"] != 0)
        bdf = (
            df.filter(df["element_type"] == 0)
            .group_by("sample_name")
            .agg(
                [
                    pl.col("cohort").first().alias("cohort"),
                    pl.col("bam_path").first().alias("bam_path"),
                    pl.col("reference_contig").first().alias("reference_contig"),
                    pl.col("reference_start").min().alias("reference_start"),
                    pl.col("reference_end").max().alias("reference_end"),
                    pl.col("is_forward").first().alias("is_forward"),
                    pl.col("query_name").first().alias("query_name"),
                    pl.col("haplotype").first().alias("haplotype"),
                    pl.col("read_group").first().alias("read_group"),
                    pl.col("element_type").first().alias("element_type"),
                    pl.col("sequence").first().alias("sequence"),
                    pl.col("column_width").first().alias("column_width"),
                ]
            )
            .select(
                [
                    "cohort",
                    "bam_path",
                    "reference_contig",
                    "reference_start",
                    "reference_end",
                    "is_forward",
                    "query_name",
                    "haplotype",
                    "read_group",
                    "sample_name",
                    "element_type",
                    "sequence",
                    "column_width",
                ]
            )
        )

        df = pl.concat([bdf, adf], rechunk=True).sort(["sample_name", "element_type"])

        y0s = []
        y0 = 0
        if not expand:
            sample_name = None
            for row in df.iter_rows(named=True):
                if sample_name is None:
                    sample_name = row["sample_name"]
                    y0 = 0

                if sample_name != row["sample_name"]:
                    sample_name = row["sample_name"]
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
        samples_df = (df.filter(df['element_type'] == 0)
            .group_by("sample_name")
            .first()
            .drop(['reference_contig', 'is_forward', 'query_name', 'read_group', 'element_type', 'sequence', 'color', 'read_num', 'y1'])
            .sort("y0", descending=True))

        # tooltips = [
        #     ('Sample Name', '@sample_name')
        # ]
        # hover = HoverTool(tooltips=tooltips)

        boxes = hv.Rectangles(
            (
                list(df["reference_start"]),
                list(df["y0"]),
                list(df["reference_end_padded"]),
                list(df["y1"]),
                list(df["color"]),
                list(df["sample_name"]),
            ),
            vdims=["color", "sample_name"],
        ).opts(
            width=width,
            height=height - 100,
            color="color",
            line_width=0,
            xlabel="",
            xformatter=BasicTickFormatter(use_scientific=False),
            ylim=(-49, 1),
            ylabel="",
            yticks=list(zip(range(0, -len(samples_df['sample_name']), -1), samples_df['sample_name'])),
            title=f"{chr}:{start:,}-{stop:,}",
            fontscale=1.3,
            tools=["xwheel_zoom", "ywheel_zoom", "pan"],
            active_tools=["xwheel_zoom", "ywheel_zoom", "pan"],
            default_tools=["reset", "save"],
        )

        range_box = hv.Rectangles(
            (
                list(df["reference_start"]),
                list(df["y0"]),
                list(df["reference_end"]),
                list(df["y1"]),
                list(df["color"]),
            ),
            vdims="color",
        ).opts(
            width=width,
            height=100,
            color="color",
            line_width=0,
            xlabel="",
            xformatter=BasicTickFormatter(use_scientific=False),
            yaxis=None,
            default_tools=[],
        )

        RangeToolLink(
            range_box,
            boxes,
            axes=["x"],
            boundsx=(df["reference_start"].min(), df["reference_end"].max()),
        )

        layout = (boxes + range_box).cols(1)
        layout.opts(opts.Layout(shared_axes=False, merge_tools=False))

        return layout

    def reset(self):
        self._session.reset()

    def print(self):
        self._session.print()


def init(
    session_name: str,
    gcs_session_dir: str = None
) -> GenomeShader:
    session = GenomeShader(
        session_name=session_name,
        gcs_session_dir=gcs_session_dir
    )

    return session


def version():
    return gs._version()

import os
import re
import warnings
from enum import Enum

import polars as pl
import holoviews as hv
from bokeh.models.formatters import BasicTickFormatter

from genomeshader.genomeshader import *

warnings.simplefilter(action='ignore', category=FutureWarning)

hv.extension("bokeh")
hv.output(backend="bokeh")

base_colors = {
    'A': '#00F100',
    'C': '#341BFF',
    'G': '#D37D2B',
    'T': '#FF0030',
    'N': '#CCCCCC'
}


class GenomeBuild(Enum):
    GRCh38 = 'GRCh38'
    chm13v2_0 = 'chm13v2.0'


class GenomeShader:
    def __init__(self,
                 session_name: str = None,
                 gcs_session_dir: str = None,
                 genome_build: GenomeBuild = None):
        self._validate_session_name(session_name)
        self.session_name = session_name

        if gcs_session_dir is None:
            bucket = os.environ['GOOGLE_BUCKET']
            gcs_session_dir = f"{bucket}/GenomeShader/{session_name}"

        self._validate_gcs_session_dir(gcs_session_dir)
        self.gcs_session_dir = gcs_session_dir

        self.genome_build: GenomeBuild = genome_build

        self.reads = set()
        self.loci = set()

    def _validate_gcs_session_dir(self, gcs_session_dir: str):
        gcs_pattern = re.compile(
            r'^gs://[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]/'  # bucket
            r'([^/]+/)*'  # folders (optional)
            r'[^/]*$'  # file (optional)
        )

        if not gcs_pattern.match(gcs_session_dir):
            raise ValueError("Invalid GCS path")

    def _validate_session_name(self, session_name: str):
        session_pattern = re.compile("^[a-zA-Z0-9_]+$")

        if not session_pattern.match(session_name):
            raise ValueError(
                "session_name contains special characters or whitespace"
            )

    def __str__(self):
        return (
            f'GenomeShader: '
            f'session_name={self.session_name}, '
            f'gcs_session_dir={self.gcs_session_dir}, '
            f'genome_build={self.genome_build}'
        )

    def get_session_name(self):
        return self.session_name

    def attach_reads(self, gcs_path: str):
        if gcs_path.endswith('.bam') or gcs_path.endswith('.cram'):
            self.reads.add(gcs_path)
        else:
            bams = gcs_list_files_of_type(gcs_path, ".bam")
            crams = gcs_list_files_of_type(gcs_path, ".cram")

            self.reads.update(bams)
            self.reads.update(crams)

    def attach_locus(self, locus: str):
        pieces = re.split("[:-]", re.sub(",", "", locus))

        chr = pieces[0]
        start = int(pieces[1])
        stop = int(pieces[2]) if len(pieces) > 2 else start

        self.loci.add((chr, start, stop))

    def stage(self):
        df = stage_data(self.gcs_session_dir, self.reads, self.loci)

        return df

    def show(self,
             locus: str,
             width: int = 980,
             height: int = 400,
             collapse: bool = False):
        pieces = re.split("[:-]", re.sub(",", "", locus))

        chr = pieces[0]
        start = int(pieces[1])
        stop = int(pieces[2]) if len(pieces) > 2 else start

        filename = f'{chr}_{start}_{stop}.parquet'
        df = pl.read_parquet(filename)
        df = df.sort(["sample_name", "query_name", "reference_start"])

        y0s = []
        y0 = 0
        if collapse:
            sample_name = None
            for row in df.iter_rows(named=True):
                if sample_name is None:
                    sample_name = row['sample_name']
                    y0 = 0

                if sample_name != row['sample_name']:
                    sample_name = row['sample_name']
                    y0 += 1

                y0s.append(y0)
        else:
            query_name = None
            for row in df.iter_rows(named=True):
                if query_name is None:
                    query_name = row['query_name']
                    y0 = 0

                if query_name != row['query_name']:
                    query_name = row['query_name']
                    y0 += 1

                y0s.append(y0)

        df = df.with_columns(pl.Series(name="read_num", values=y0s))

        df = df.with_columns(
            pl.col("read_num").alias("y0") * -1 - pl.col("height") / 2
        )
        df = df.with_columns(
            pl.col("read_num").alias("y1") * -1 + pl.col("height") / 2
        )

        boxes = hv.Rectangles((
            list(df["reference_start"]),
            list(df["y0"]),
            list(df["reference_end"]),
            list(df["y1"]),
            list(df["element_type"])
        ), vdims="element_type")

        return boxes.opts(
            width=width,
            height=height,

            xlabel="",
            xformatter=BasicTickFormatter(use_scientific=False),
            yaxis=None,
            ylim=(-18, 1),

            title="Read visualization",
            fontscale=1.3,
            color="element_type",

            line_width=0,

            tools=['xwheel_zoom', 'ywheel_zoom', 'pan'],
            active_tools=['xwheel_zoom', 'pan'],
            default_tools=['reset', 'save']
        )


def init(session_name,
         gcs_session_dir: str = None,
         genome_build: GenomeBuild = GenomeBuild.GRCh38) -> GenomeShader:
    session = GenomeShader(session_name=session_name,
                           gcs_session_dir=gcs_session_dir,
                           genome_build=genome_build)

    return session

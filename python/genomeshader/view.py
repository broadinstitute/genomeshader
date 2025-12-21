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
        "main main aside"
        "footer footer aside";
    grid-template-rows: 1fr auto;
    grid-template-columns: 1fr auto;
    height: 100vh;
    margin: 0;
    padding: 0;
    overflow: hidden;
}
nav {
    grid-area: nav;
}
main {
    grid-area: main;
    height: calc(100vh - 40px);
    cursor: default;
}
main.panning {
    cursor: grabbing;
    user-select: none;
    -webkit-user-select: none;
    -moz-user-select: none;
    -ms-user-select: none;
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
.sidebar-icon-close {
    display: none;
    cursor: pointer;
}
.sidebar-icon-open {
    cursor: pointer;
}
footer {
    position: fixed;
    bottom: 10px;
    right: 10px;
    height: 20px;
    padding: 6px 12px;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    color: #989898;
    font-family: Helvetica;
    font-size: 10pt;
    user-select: none; /* Disable text selection */
    -webkit-user-select: none; /* Safari */
    -moz-user-select: none; /* Firefox */
    -ms-user-select: none; /* Internet Explorer/Edge */
    opacity: 0;
    transition: opacity 0.3s ease-in-out;
    pointer-events: none;
    background-color: rgba(255, 255, 255, 0.9);
    border-radius: 4px;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}
footer.visible {
    opacity: 1;
    pointer-events: auto;
}
.status-bar {
    display: flex;
    align-items: center;
    gap: 15px;
    font-family: 'Courier New', monospace;
    font-size: 9pt;
}
.status-item {
    display: flex;
    align-items: center;
    gap: 5px;
}
.status-label {
    color: #666666;
    font-weight: normal;
}
.status-value {
    color: #333333;
    font-weight: bold;
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
/* Context menu styles */
.context-menu {
    display: none;
    position: fixed;
    background-color: #ffffff;
    border: 1px solid #cccccc;
    border-radius: 4px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    z-index: 1000;
    min-width: 180px;
    padding: 4px 0;
    font-family: Helvetica;
    font-size: 11pt;
}
.context-menu-item {
    padding: 8px 16px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 8px;
    color: #333333;
}
.context-menu-item:hover {
    background-color: #f0f0f0;
}
.context-menu-item.disabled {
    color: #999999;
    cursor: not-allowed;
}
.context-menu-item.disabled:hover {
    background-color: transparent;
}
.context-menu-separator {
    height: 1px;
    background-color: #e0e0e0;
    margin: 4px 0;
}
.context-menu-item.has-submenu {
    position: relative;
}
.context-menu-item.has-submenu::after {
    content: '▶';
    margin-left: auto;
    font-size: 8pt;
    color: #999999;
}
.context-submenu {
    display: none;
    position: absolute;
    left: 100%;
    top: 0;
    margin-left: 4px;
    background-color: #ffffff;
    border: 1px solid #cccccc;
    border-radius: 4px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    min-width: 120px;
    padding: 4px 0;
    z-index: 1001;
}
.context-menu-item.has-submenu:hover .context-submenu {
    display: block;
}
/* Resize indicator styles */
.resize-indicator {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background-color: rgba(0, 0, 0, 0.7);
    color: #ffffff;
    padding: 12px 20px;
    border-radius: 6px;
    font-family: 'Courier New', monospace;
    font-size: 14pt;
    font-weight: bold;
    z-index: 2000;
    opacity: 0;
    transition: opacity 0.3s ease-in-out;
    pointer-events: none;
    user-select: none;
    -webkit-user-select: none;
    -moz-user-select: none;
    -ms-user-select: none;
}
.resize-indicator.visible {
    opacity: 1;
}
        """

        inner_body = """
<main style="width: 100%;">
<footer>
    <div class="status-bar" id="statusBar">
        <div class="status-item">
            <span class="status-label">Position:</span>
            <span class="status-value" id="genomicPosition">--</span>
        </div>
        <div class="status-item">
            <span class="status-label">Render:</span>
            <span class="status-value" id="renderTime">--</span>
        </div>
        <div class="status-item">
            <span class="status-label">Shapes:</span>
            <span class="status-value" id="shapeCount">--</span>
        </div>
    </div>
</footer>

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

<!-- Context Menu -->
<div id="contextMenu" class="context-menu">
    <div class="context-menu-item" onclick="toggleOrientation(); hideContextMenu();">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 2v20M2 12h20" stroke-linecap="round"/>
        </svg>
        <span>Toggle Orientation</span>
    </div>
    <div class="context-menu-item" onclick="toggleSidebar(); hideContextMenu();">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 3h18v18H3z" stroke-linecap="round"/>
            <path d="M9 9l6 6M15 9l-6 6" stroke-linecap="round"/>
        </svg>
        <span>Toggle Sidebar</span>
    </div>
    <div class="context-menu-separator"></div>
    <a href="https://github.com/broadinstitute/genomeshader/issues" target="_blank" class="context-menu-item" onclick="hideContextMenu();">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 3h18v18H3z" stroke-linecap="round"/>
            <path d="M12 8v4M12 16h.01" stroke-linecap="round"/>
        </svg>
        <span>Report Bug</span>
    </a>
    <div class="context-menu-item disabled" onclick="hideContextMenu();">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="3"/>
            <path d="M12 1v6m0 6v6M5.64 5.64l4.24 4.24m4.24 4.24l4.24 4.24M1 12h6m6 0h6M5.64 18.36l4.24-4.24m4.24-4.24l4.24-4.24"/>
        </svg>
        <span>Settings</span>
    </div>
</div>

<!-- Resize Indicator -->
<div id="resizeIndicator" class="resize-indicator">
    <span id="resizeDimensions">-- × --</span>
</div>
        """

        inner_script = """
window.zoom = 0;
let statusBarHideTimeout = null;

// Status bar management
function showStatusBar() {
    const footer = document.querySelector('footer');
    if (footer) {
        footer.classList.add('visible');
        // Clear any existing timeout
        if (statusBarHideTimeout) {
            clearTimeout(statusBarHideTimeout);
        }
        // Auto-hide after 5 seconds
        statusBarHideTimeout = setTimeout(() => {
            hideStatusBar();
        }, 5000);
    }
}

function hideStatusBar() {
    const footer = document.querySelector('footer');
    if (footer) {
        footer.classList.remove('visible');
    }
    if (statusBarHideTimeout) {
        clearTimeout(statusBarHideTimeout);
        statusBarHideTimeout = null;
    }
}

// Make functions available globally for module script
window.showStatusBar = showStatusBar;
window.hideStatusBar = hideStatusBar;

// Helper function to get genomic position from mouse event
function getGenomicPositionFromEvent(event) {
    const main = document.querySelector('main');
    if (!main || !window.data || !window.data.locus_start || !window.data.locus_end) {
        return null;
    }
    
    // Get mouse position relative to the main element
    const mainRect = main.getBoundingClientRect();
    const mainX = event.clientX - mainRect.left;
    const mainY = event.clientY - mainRect.top;
    
    // Get the bases per pixel conversion factor (same as used in rendering)
    let basesPerPixel;
    let drawingStart, drawingEnd, pixelPos;
    let genomicPos;
    
    if (window.data.orientation === 'horizontal') {
        // For horizontal orientation, Y coordinate maps to genomic position (inverted)
        // The drawing area starts at pixel 20 and ends at main.offsetHeight - 35
        basesPerPixel = (window.data.locus_end - window.data.locus_start) / (main.offsetHeight - 20 - 20 - 35);
        drawingStart = 20;
        drawingEnd = main.offsetHeight - 35;
        pixelPos = mainY - drawingStart;
        
        // Reverse the transformation: genomicPos = locus_end - (pixelPos * basesPerPixel)
        // Note: Y increases downward, but genomic position increases upward, so we invert
        genomicPos = window.data.locus_end - (pixelPos * basesPerPixel);
    } else {
        // For vertical orientation, X coordinate maps to genomic position
        // The drawing area starts at pixel 20 and ends at main.offsetWidth - 200
        basesPerPixel = (window.data.locus_end - window.data.locus_start) / (main.offsetWidth - 200);
        drawingStart = 20;
        drawingEnd = main.offsetWidth - 200;
        pixelPos = mainX - drawingStart;
        
        // Reverse the transformation: genomicPos = locus_start + (pixelPos * basesPerPixel)
        genomicPos = window.data.locus_start + (pixelPos * basesPerPixel);
    }
    
    if (basesPerPixel <= 0) {
        return null;
    }
    
    // Check if mouse is within the drawing area
    if (pixelPos < 0 || pixelPos > (drawingEnd - drawingStart)) {
        return null;
    }
    
    // Clamp genomic position to valid range
    genomicPos = Math.max(window.data.locus_start, Math.min(window.data.locus_end, genomicPos));
    
    return genomicPos;
}

// Function to update genomic position from mouse coordinates
function updateGenomicPosition(event) {
    const genomicPos = getGenomicPositionFromEvent(event);
    
    if (genomicPos === null) {
        const positionEl = document.getElementById('genomicPosition');
        if (positionEl) {
            positionEl.textContent = '--';
        }
        return;
    }
    
    // Format the position with chromosome
    const chr = window.data.ref_chr || window.data.chr || window.data.chromosome || window.data.chrom || '';
    const position = chr ? chr + ':' + Math.floor(genomicPos).toLocaleString() : Math.floor(genomicPos).toLocaleString();
    
    const positionEl = document.getElementById('genomicPosition');
    if (positionEl) {
        positionEl.textContent = position;
    }
    
    showStatusBar();
}

// Zoom handler
document.addEventListener('wheel', function(e) {
    window.zoom += e.deltaY;
    showStatusBar();
});

// Mouse move handler for genomic position
document.addEventListener('mousemove', function(e) {
    // Only track if mouse is over the main element
    const main = document.querySelector('main');
    if (!main) {
        return;
    }
    
    const rect = main.getBoundingClientRect();
    const x = e.clientX;
    const y = e.clientY;
    
    // Check if mouse is within main element bounds
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        updateGenomicPosition(e);
    }
});

// Resize indicator management
let resizeIndicatorHideTimeout = null;

function showResizeIndicator() {
    const canvas = document.querySelector('canvas');
    const indicator = document.getElementById('resizeIndicator');
    const dimensionsEl = document.getElementById('resizeDimensions');
    
    if (!canvas || !indicator || !dimensionsEl) {
        return;
    }
    
    // Get canvas dimensions
    const width = canvas.width;
    const height = canvas.height;
    
    // Update dimensions text
    dimensionsEl.textContent = width + ' × ' + height;
    
    // Show the indicator
    indicator.classList.add('visible');
    
    // Clear any existing timeout
    if (resizeIndicatorHideTimeout) {
        clearTimeout(resizeIndicatorHideTimeout);
    }
    
    // Auto-hide after 2 seconds
    resizeIndicatorHideTimeout = setTimeout(() => {
        hideResizeIndicator();
    }, 2000);
}

function hideResizeIndicator() {
    const indicator = document.getElementById('resizeIndicator');
    if (indicator) {
        indicator.classList.remove('visible');
    }
    if (resizeIndicatorHideTimeout) {
        clearTimeout(resizeIndicatorHideTimeout);
        resizeIndicatorHideTimeout = null;
    }
}

// Window resize handler with debouncing
let resizeTimeout = null;
window.addEventListener('resize', function() {
    // Clear existing timeout
    if (resizeTimeout) {
        clearTimeout(resizeTimeout);
    }
    
    // Debounce the resize handler to avoid too many updates
    resizeTimeout = setTimeout(() => {
        showResizeIndicator();
    }, 100);
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

function toggleSidebar() {
    const aside = document.querySelector('aside');
    if (aside.style.width === '0px' || aside.style.width === '') {
        openSidebar();
    } else {
        closeSidebar();
    }
}

// Toggle orientation between horizontal and vertical
function toggleOrientation() {
    if (!window.data) {
        console.error('window.data is not available');
        return;
    }
    window.data.orientation = window.data.orientation === 'horizontal' ? 'vertical' : 'horizontal';
    // Clear UI elements to force redraw
    if (window.data.uiElements) {
        window.data.uiElements = {};
    }
    // Call repaint if it's available (it's defined in the module script)
    if (typeof window.repaint === 'function') {
        window.repaint();
    } else if (typeof repaint === 'function') {
        repaint();
    } else {
        // If repaint isn't available yet, try again after a short delay
        setTimeout(() => {
            if (typeof window.repaint === 'function') {
                window.repaint();
            } else if (typeof repaint === 'function') {
                repaint();
            }
        }, 100);
    }
}

// Context menu functions
function showContextMenu(event) {
    event.preventDefault();
    const contextMenu = document.getElementById('contextMenu');
    contextMenu.style.display = 'block';
    
    // Position the menu at the cursor location
    contextMenu.style.left = event.pageX + 'px';
    contextMenu.style.top = event.pageY + 'px';
    
    // Adjust if menu goes off screen
    const rect = contextMenu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
        contextMenu.style.left = (event.pageX - rect.width) + 'px';
    }
    if (rect.bottom > window.innerHeight) {
        contextMenu.style.top = (event.pageY - rect.height) + 'px';
    }
}

function hideContextMenu() {
    const contextMenu = document.getElementById('contextMenu');
    contextMenu.style.display = 'none';
}

// Add right-click event listener to main canvas area
document.addEventListener('contextmenu', function(e) {
    // Only show context menu if clicking on main area (not on footer, aside, etc.)
    const target = e.target;
    if (target.closest('main') && !target.closest('footer') && !target.closest('aside')) {
        showContextMenu(e);
    }
});

// Hide context menu when clicking elsewhere
document.addEventListener('click', function(e) {
    if (!e.target.closest('#contextMenu')) {
        hideContextMenu();
    }
});

// Hide context menu on escape key
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
        hideContextMenu();
    }
});

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
// Initialize window.data if it doesn't exist
if (!window.data) {{
    window.data = {{}};
}}

// Parse and set the main data
const parsedData = JSON.parse({json.dumps(data_json)});
Object.assign(window.data, parsedData);

// Function to decode and parse the reference bases
window.encoded_ref = "{encoded_ref}";
window.data.ref = JSON.parse(decompressEncodedData(encoded_ref));

// Function to decode and parse the reads
window.encoded_samples = "{encoded_samples}";
window.data.samples = JSON.parse(decompressEncodedData(encoded_samples));

// Signal that data is ready
window.data._ready = true;
        """

        inner_module = """
// WebGPU Core - Device initialization and canvas setup
class WebGPUCore {
    constructor() {
        this.device = null;
        this.context = null;
        this.canvas = null;
        this.format = null;
        this.projectionMatrix = null;
        this.projectionBuffer = null;
    }

    async init(canvas) {
        if (!navigator.gpu) {
            throw new Error('WebGPU is not supported in this browser');
        }

        this.canvas = canvas;
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            throw new Error('Failed to get WebGPU adapter');
        }

        this.device = await adapter.requestDevice();
        this.format = navigator.gpu.getPreferredCanvasFormat();
        
        this.context = canvas.getContext('webgpu');
        if (!this.context) {
            throw new Error('Failed to get WebGPU context');
        }

        const devicePixelRatio = window.devicePixelRatio || 1;
        const width = canvas.clientWidth * devicePixelRatio;
        const height = canvas.clientHeight * devicePixelRatio;

        this.context.configure({
            device: this.device,
            format: this.format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
            alphaMode: 'premultiplied',
        });

        // Create projection matrix buffer (orthographic 2D projection)
        this.projectionMatrix = new Float32Array([
            2.0 / width, 0, 0, 0,
            0, -2.0 / height, 0, 0,
            0, 0, 1, 0,
            -1, 1, 0, 1
        ]);

        this.projectionBuffer = this.device.createBuffer({
            size: 16 * 4, // 16 floats * 4 bytes
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this.device.queue.writeBuffer(this.projectionBuffer, 0, this.projectionMatrix);

        // Handle resize
        window.addEventListener('resize', () => this.handleResize());
    }

    handleResize() {
        if (!this.canvas || !this.context) return;

        const devicePixelRatio = window.devicePixelRatio || 1;
        const width = this.canvas.clientWidth * devicePixelRatio;
        const height = this.canvas.clientHeight * devicePixelRatio;

        // Update canvas size
        this.canvas.width = width;
        this.canvas.height = height;

        // Update projection matrix
        this.projectionMatrix[0] = 2.0 / width;
        this.projectionMatrix[5] = -2.0 / height;
        this.projectionMatrix[12] = -1;
        this.projectionMatrix[13] = 1;

        this.device.queue.writeBuffer(this.projectionBuffer, 0, this.projectionMatrix);
    }

    getCurrentTexture() {
        return this.context.getCurrentTexture();
    }

    createCommandEncoder() {
        return this.device.createCommandEncoder();
    }

    submit(commands) {
        this.device.queue.submit(commands);
    }
}

// Instanced Renderer - GPU instanced rendering for polygons
class InstancedRenderer {
    constructor(webgpuCore) {
        this.core = webgpuCore;
        this.device = webgpuCore.device;
        
        // Rectangle rendering
        this.rectPipeline = null;
        this.rectInstances = [];
        this.rectBuffer = null;
        this.rectVertexBuffer = null;
        
        // Triangle rendering
        this.trianglePipeline = null;
        this.triangleInstances = [];
        this.triangleBuffer = null;
        this.triangleVertexBuffer = null;
        
        // Line rendering
        this.linePipeline = null;
        this.lineInstances = [];
        this.lineBuffer = null;
        
        this.init();
    }

    init() {
        this.createRectPipeline();
        this.createTrianglePipeline();
        this.createLinePipeline();
        this.createGeometryBuffers();
    }

    // Convert hex color to normalized RGBA
    hexToRgba(hex, alpha = 1.0) {
        if (typeof hex === 'string') {
            if (hex.startsWith('#')) {
                hex = hex.slice(1);
            }
            const r = parseInt(hex.slice(0, 2), 16) / 255;
            const g = parseInt(hex.slice(2, 4), 16) / 255;
            const b = parseInt(hex.slice(4, 6), 16) / 255;
            return [r, g, b, alpha];
        } else {
            // Assume it's a number (0xRRGGBB)
            const r = ((hex >> 16) & 0xFF) / 255;
            const g = ((hex >> 8) & 0xFF) / 255;
            const b = (hex & 0xFF) / 255;
            return [r, g, b, alpha];
        }
    }

    createRectPipeline() {
        const vertexShader = `
            struct Uniforms {
                projection: mat4x4<f32>,
            }
            @group(0) @binding(0) var<uniform> uniforms: Uniforms;

            struct VertexOutput {
                @builtin(position) position: vec4<f32>,
                @location(2) @interpolate(flat) color: vec4<f32>,
            }

            @vertex
            fn vs_main(
                @builtin(vertex_index) vertexIndex: u32,
                @builtin(instance_index) instanceIndex: u32,
                @location(0) position: vec2<f32>,
                @location(1) size: vec2<f32>,
                @location(2) color: vec4<f32>
            ) -> VertexOutput {
                // Quad vertices: (-0.5, -0.5), (0.5, -0.5), (-0.5, 0.5), (0.5, 0.5)
                var quadPos = vec2<f32>(0.0);
                if (vertexIndex == 0u) {
                    quadPos = vec2<f32>(-0.5, -0.5);
                } else if (vertexIndex == 1u) {
                    quadPos = vec2<f32>(0.5, -0.5);
                } else if (vertexIndex == 2u) {
                    quadPos = vec2<f32>(-0.5, 0.5);
                } else {
                    quadPos = vec2<f32>(0.5, 0.5);
                }
                
                var worldPos = position + quadPos * size;
                var output: VertexOutput;
                output.position = uniforms.projection * vec4<f32>(worldPos, 0.0, 1.0);
                output.color = color;
                return output;
            }
        `;

        const fragmentShader = `
            @fragment
            fn fs_main(
                @location(2) @interpolate(flat) color: vec4<f32>
            ) -> @location(0) vec4<f32> {
                return color;
            }
        `;

        const vertexModule = this.device.createShaderModule({ code: vertexShader });
        const fragmentModule = this.device.createShaderModule({ code: fragmentShader });

        this.rectPipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: vertexModule,
                entryPoint: 'vs_main',
                buffers: [
                    {
                        arrayStride: 8 * 4, // position(8) + size(8) + color(16) = 32 bytes
                        stepMode: 'instance',
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: 'float32x2' }, // position
                            { shaderLocation: 1, offset: 8, format: 'float32x2' }, // size
                            { shaderLocation: 2, offset: 16, format: 'float32x4' }, // color
                        ],
                    },
                ],
            },
            fragment: {
                module: fragmentModule,
                entryPoint: 'fs_main',
                targets: [{ format: this.core.format }],
            },
            primitive: {
                topology: 'triangle-strip',
            },
        });
    }

    createTrianglePipeline() {
        const vertexShader = `
            struct Uniforms {
                projection: mat4x4<f32>,
            }
            @group(0) @binding(0) var<uniform> uniforms: Uniforms;

            struct VertexOutput {
                @builtin(position) position: vec4<f32>,
                @location(3) @interpolate(flat) color: vec4<f32>,
            }

            @vertex
            fn vs_main(
                @builtin(vertex_index) vertexIndex: u32,
                @builtin(instance_index) instanceIndex: u32,
                @location(0) v0: vec2<f32>,
                @location(1) v1: vec2<f32>,
                @location(2) v2: vec2<f32>,
                @location(3) color: vec4<f32>
            ) -> VertexOutput {
                var pos: vec2<f32>;
                if (vertexIndex == 0u) {
                    pos = v0;
                } else if (vertexIndex == 1u) {
                    pos = v1;
                } else {
                    pos = v2;
                }
                var output: VertexOutput;
                output.position = uniforms.projection * vec4<f32>(pos, 0.0, 1.0);
                output.color = color;
                return output;
            }
        `;

        const fragmentShader = `
            @fragment
            fn fs_main(
                @location(3) @interpolate(flat) color: vec4<f32>
            ) -> @location(0) vec4<f32> {
                return color;
            }
        `;

        const vertexModule = this.device.createShaderModule({ code: vertexShader });
        const fragmentModule = this.device.createShaderModule({ code: fragmentShader });

        this.trianglePipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: vertexModule,
                entryPoint: 'vs_main',
                buffers: [
                    {
                        arrayStride: 10 * 4, // v0(8) + v1(8) + v2(8) + color(16) = 40 bytes
                        stepMode: 'instance',
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: 'float32x2' }, // v0
                            { shaderLocation: 1, offset: 8, format: 'float32x2' }, // v1
                            { shaderLocation: 2, offset: 16, format: 'float32x2' }, // v2
                            { shaderLocation: 3, offset: 24, format: 'float32x4' }, // color
                        ],
                    },
                ],
            },
            fragment: {
                module: fragmentModule,
                entryPoint: 'fs_main',
                targets: [{ format: this.core.format }],
            },
            primitive: {
                topology: 'triangle-list',
            },
        });
    }

    createLinePipeline() {
        const vertexShader = `
            struct Uniforms {
                projection: mat4x4<f32>,
            }
            @group(0) @binding(0) var<uniform> uniforms: Uniforms;

            struct VertexOutput {
                @builtin(position) position: vec4<f32>,
                @location(2) @interpolate(flat) color: vec4<f32>,
            }

            @vertex
            fn vs_main(
                @builtin(vertex_index) vertexIndex: u32,
                @builtin(instance_index) instanceIndex: u32,
                @location(0) start: vec2<f32>,
                @location(1) end: vec2<f32>,
                @location(2) color: vec4<f32>
            ) -> VertexOutput {
                var pos: vec2<f32>;
                if (vertexIndex == 0u) {
                    pos = start;
                } else {
                    pos = end;
                }
                var output: VertexOutput;
                output.position = uniforms.projection * vec4<f32>(pos, 0.0, 1.0);
                output.color = color;
                return output;
            }
        `;

        const fragmentShader = `
            @fragment
            fn fs_main(
                @location(2) @interpolate(flat) color: vec4<f32>
            ) -> @location(0) vec4<f32> {
                return color;
            }
        `;

        const vertexModule = this.device.createShaderModule({ code: vertexShader });
        const fragmentModule = this.device.createShaderModule({ code: fragmentShader });

        this.linePipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: vertexModule,
                entryPoint: 'vs_main',
                buffers: [
                    {
                        arrayStride: 8 * 4, // start(8) + end(8) + color(16) = 32 bytes
                        stepMode: 'instance',
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: 'float32x2' }, // start
                            { shaderLocation: 1, offset: 8, format: 'float32x2' }, // end
                            { shaderLocation: 2, offset: 16, format: 'float32x4' }, // color
                        ],
                    },
                ],
            },
            fragment: {
                module: fragmentModule,
                entryPoint: 'fs_main',
                targets: [{ format: this.core.format }],
            },
            primitive: {
                topology: 'line-list',
            },
        });
    }

    createGeometryBuffers() {
        // Rectangle uses triangle-strip, no vertex buffer needed (generated in shader)
        // Triangle uses triangle-list, no vertex buffer needed (generated in shader)
        // Line uses line-list, no vertex buffer needed (generated in shader)
    }

    // Add rectangle instance
    addRect(x, y, width, height, color, alpha = 1.0) {
        const rgba = this.hexToRgba(color, alpha);
        this.rectInstances.push({
            position: [x + width / 2, y + height / 2], // center position
            size: [width, height],
            color: rgba,
        });
    }

    // Add triangle instance
    addTriangle(x0, y0, x1, y1, x2, y2, color, alpha = 1.0) {
        const rgba = this.hexToRgba(color, alpha);
        this.triangleInstances.push({
            v0: [x0, y0],
            v1: [x1, y1],
            v2: [x2, y2],
            color: rgba,
        });
    }

    // Add line instance
    addLine(x0, y0, x1, y1, color, alpha = 1.0) {
        const rgba = this.hexToRgba(color, alpha);
        this.lineInstances.push({
            start: [x0, y0],
            end: [x1, y1],
            color: rgba,
        });
    }

    // Clear all instances
    clear() {
        this.rectInstances = [];
        this.triangleInstances = [];
        this.lineInstances = [];
    }

    // Render all instances
    render(encoder, renderPass) {
        // Create uniform bind group (same layout for all pipelines)
        const uniformBindGroupLayout = this.rectPipeline.getBindGroupLayout(0);
        const uniformBindGroup = this.device.createBindGroup({
            layout: uniformBindGroupLayout,
            entries: [
                {
                    binding: 0,
                    resource: {
                        buffer: this.core.projectionBuffer,
                    },
                },
            ],
        });

        // Render rectangles
        if (this.rectInstances.length > 0) {
            const instanceData = new Float32Array(this.rectInstances.length * 8);
            for (let i = 0; i < this.rectInstances.length; i++) {
                const inst = this.rectInstances[i];
                const offset = i * 8;
                instanceData[offset + 0] = inst.position[0];
                instanceData[offset + 1] = inst.position[1];
                instanceData[offset + 2] = inst.size[0];
                instanceData[offset + 3] = inst.size[1];
                instanceData[offset + 4] = inst.color[0];
                instanceData[offset + 5] = inst.color[1];
                instanceData[offset + 6] = inst.color[2];
                instanceData[offset + 7] = inst.color[3];
            }

            if (!this.rectBuffer || this.rectBuffer.size < instanceData.byteLength) {
                if (this.rectBuffer) this.rectBuffer.destroy();
                this.rectBuffer = this.device.createBuffer({
                    size: instanceData.byteLength,
                    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
                });
            }

            this.device.queue.writeBuffer(this.rectBuffer, 0, instanceData);

            renderPass.setPipeline(this.rectPipeline);
            renderPass.setBindGroup(0, uniformBindGroup);
            renderPass.setVertexBuffer(0, this.rectBuffer);
            renderPass.draw(4, this.rectInstances.length); // 4 vertices per quad
        }

        // Render triangles
        if (this.triangleInstances.length > 0) {
            // v0(2) + v1(2) + v2(2) + color(4) = 10 floats per instance
            const instanceData = new Float32Array(this.triangleInstances.length * 10);
            for (let i = 0; i < this.triangleInstances.length; i++) {
                const inst = this.triangleInstances[i];
                const offset = i * 10;
                instanceData[offset + 0] = inst.v0[0];
                instanceData[offset + 1] = inst.v0[1];
                instanceData[offset + 2] = inst.v1[0];
                instanceData[offset + 3] = inst.v1[1];
                instanceData[offset + 4] = inst.v2[0];
                instanceData[offset + 5] = inst.v2[1];
                instanceData[offset + 6] = inst.color[0];
                instanceData[offset + 7] = inst.color[1];
                instanceData[offset + 8] = inst.color[2];
                instanceData[offset + 9] = inst.color[3];
            }

            if (!this.triangleBuffer || this.triangleBuffer.size < instanceData.byteLength) {
                if (this.triangleBuffer) this.triangleBuffer.destroy();
                this.triangleBuffer = this.device.createBuffer({
                    size: instanceData.byteLength,
                    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
                });
            }

            this.device.queue.writeBuffer(this.triangleBuffer, 0, instanceData);

            const triangleUniformBindGroup = this.device.createBindGroup({
                layout: this.trianglePipeline.getBindGroupLayout(0),
                entries: [
                    {
                        binding: 0,
                        resource: {
                            buffer: this.core.projectionBuffer,
                        },
                    },
                ],
            });
            
            renderPass.setPipeline(this.trianglePipeline);
            renderPass.setBindGroup(0, triangleUniformBindGroup);
            renderPass.setVertexBuffer(0, this.triangleBuffer);
            renderPass.draw(3, this.triangleInstances.length); // 3 vertices per triangle
        }

        // Render lines
        if (this.lineInstances.length > 0) {
            const instanceData = new Float32Array(this.lineInstances.length * 8);
            for (let i = 0; i < this.lineInstances.length; i++) {
                const inst = this.lineInstances[i];
                const offset = i * 8;
                instanceData[offset + 0] = inst.start[0];
                instanceData[offset + 1] = inst.start[1];
                instanceData[offset + 2] = inst.end[0];
                instanceData[offset + 3] = inst.end[1];
                instanceData[offset + 4] = inst.color[0];
                instanceData[offset + 5] = inst.color[1];
                instanceData[offset + 6] = inst.color[2];
                instanceData[offset + 7] = inst.color[3];
            }

            if (!this.lineBuffer || this.lineBuffer.size < instanceData.byteLength) {
                if (this.lineBuffer) this.lineBuffer.destroy();
                this.lineBuffer = this.device.createBuffer({
                    size: instanceData.byteLength,
                    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
                });
            }

            this.device.queue.writeBuffer(this.lineBuffer, 0, instanceData);

            const lineUniformBindGroup = this.device.createBindGroup({
                layout: this.linePipeline.getBindGroupLayout(0),
                entries: [
                    {
                        binding: 0,
                        resource: {
                            buffer: this.core.projectionBuffer,
                        },
                    },
                ],
            });
            
            renderPass.setPipeline(this.linePipeline);
            renderPass.setBindGroup(0, lineUniformBindGroup);
            renderPass.setVertexBuffer(0, this.lineBuffer);
            renderPass.draw(2, this.lineInstances.length); // 2 vertices per line
        }
    }

    // Get rendering statistics
    getStats() {
        return {
            rectangles: this.rectInstances.length,
            triangles: this.triangleInstances.length,
            lines: this.lineInstances.length,
            totalPolygons: this.rectInstances.length + this.triangleInstances.length + this.lineInstances.length,
        };
    }
}

// Text Renderer - Canvas 2D text to WebGPU texture rendering
class TextRenderer {
    constructor(webgpuCore) {
        this.core = webgpuCore;
        this.device = webgpuCore.device;
        this.textCache = new Map(); // Cache rendered text textures
        this.canvas = document.createElement('canvas');
        this.ctx = this.canvas.getContext('2d');
        this.textInstances = [];
        this.textPipeline = null;
        this.textBuffer = null;
        this.textVertexBuffer = null;
        this.sampler = null;
        
        this.init();
    }

    init() {
        this.createTextPipeline();
        this.createSampler();
    }

    createSampler() {
        this.sampler = this.device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
        });
    }

    createTextPipeline() {
        const vertexShader = `
            struct Uniforms {
                projection: mat4x4<f32>,
            }
            @group(0) @binding(0) var<uniform> uniforms: Uniforms;

            @group(1) @binding(0) var texture: texture_2d<f32>;
            @group(1) @binding(1) var texSampler: sampler;

            struct VertexOutput {
                @builtin(position) position: vec4<f32>,
                @location(0) uv: vec2<f32>,
            }

            @vertex
            fn vs_main(
                @builtin(vertex_index) vertexIndex: u32,
                @builtin(instance_index) instanceIndex: u32,
                @location(0) position: vec2<f32>,
                @location(1) size: vec2<f32>,
                @location(2) texCoord: vec2<f32>,
                @location(3) texSize: vec2<f32>
            ) -> VertexOutput {
                // Quad vertices: (-0.5, -0.5), (0.5, -0.5), (-0.5, 0.5), (0.5, 0.5)
                var quadPos = vec2<f32>(0.0);
                var quadUV = vec2<f32>(0.0);
                if (vertexIndex == 0u) {
                    quadPos = vec2<f32>(-0.5, -0.5);
                    quadUV = vec2<f32>(0.0, 1.0);
                } else if (vertexIndex == 1u) {
                    quadPos = vec2<f32>(0.5, -0.5);
                    quadUV = vec2<f32>(1.0, 1.0);
                } else if (vertexIndex == 2u) {
                    quadPos = vec2<f32>(-0.5, 0.5);
                    quadUV = vec2<f32>(0.0, 0.0);
                } else {
                    quadPos = vec2<f32>(0.5, 0.5);
                    quadUV = vec2<f32>(1.0, 0.0);
                }
                
                var worldPos = position + quadPos * size;
                var uv = texCoord + quadUV * texSize;
                
                var output: VertexOutput;
                output.position = uniforms.projection * vec4<f32>(worldPos, 0.0, 1.0);
                output.uv = uv;
                return output;
            }
        `;

        const fragmentShader = `
            @group(1) @binding(0) var texture: texture_2d<f32>;
            @group(1) @binding(1) var texSampler: sampler;

            @fragment
            fn fs_main(
                @location(0) uv: vec2<f32>
            ) -> @location(0) vec4<f32> {
                return textureSample(texture, texSampler, uv);
            }
        `;

        const vertexModule = this.device.createShaderModule({ code: vertexShader });
        const fragmentModule = this.device.createShaderModule({ code: fragmentShader });

        this.textPipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: vertexModule,
                entryPoint: 'vs_main',
                buffers: [
                    {
                        arrayStride: 8 * 4, // position(8) + size(8) + texCoord(8) + texSize(8) = 32 bytes
                        stepMode: 'instance',
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: 'float32x2' }, // position
                            { shaderLocation: 1, offset: 8, format: 'float32x2' }, // size
                            { shaderLocation: 2, offset: 16, format: 'float32x2' }, // texCoord
                            { shaderLocation: 3, offset: 24, format: 'float32x2' }, // texSize
                        ],
                    },
                ],
            },
            fragment: {
                module: fragmentModule,
                entryPoint: 'fs_main',
                targets: [{ format: this.core.format }],
            },
            primitive: {
                topology: 'triangle-strip',
            },
        });
    }

    // Render text to texture and cache it
    async renderTextToTexture(text, style = {}, rotation = 0, flipVertical = false) {
        const cacheKey = `${text}_${JSON.stringify(style)}_${rotation}_${flipVertical}`;
        
        if (this.textCache.has(cacheKey)) {
            return this.textCache.get(cacheKey);
        }

        const fontFamily = style.fontFamily || 'Helvetica';
        const fontSize = style.fontSize || 12;
        const fontWeight = style.fontWeight || 'normal';
        const fill = style.fill || '#000000';
        const align = style.align || 'left';

        // Set up canvas for measurement
        this.ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
        this.ctx.textAlign = 'left'; // Use left for measurement
        this.ctx.textBaseline = 'alphabetic';
        
        // Measure text with better accuracy
        const metrics = this.ctx.measureText(text);
        const textWidth = Math.ceil(metrics.width);
        // Use actual bounding box if available, otherwise estimate
        const textHeight = metrics.actualBoundingBoxAscent && metrics.actualBoundingBoxDescent
            ? Math.ceil(metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent)
            : Math.ceil(fontSize * 1.5); // More padding for safety
        
        // Add extra padding to prevent clipping
        const padding = 4;
        const paddedWidth = textWidth + padding * 2;
        const paddedHeight = textHeight + padding * 2;
        
        // If rotated, calculate bounding box with padding
        let canvasWidth, canvasHeight;
        if (Math.abs(rotation) > 0.001) {
            const cos = Math.abs(Math.cos(rotation));
            const sin = Math.abs(Math.sin(rotation));
            canvasWidth = Math.ceil(paddedWidth * cos + paddedHeight * sin) + padding;
            canvasHeight = Math.ceil(paddedWidth * sin + paddedHeight * cos) + padding;
        } else {
            canvasWidth = paddedWidth;
            canvasHeight = paddedHeight;
        }
        
        this.canvas.width = canvasWidth;
        this.canvas.height = canvasHeight;
        
        // Clear and set up context
        this.ctx.clearRect(0, 0, canvasWidth, canvasHeight);
        this.ctx.save();
        
        // Move to center of canvas
        this.ctx.translate(canvasWidth / 2, canvasHeight / 2);
        
        // Apply rotation around center
        if (Math.abs(rotation) > 0.001) {
            this.ctx.rotate(rotation);
        }
        
        // Apply vertical flip if requested (for horizontal orientation)
        if (flipVertical) {
            this.ctx.scale(1, -1);
        }
        
        // Draw text centered at origin (which is now canvas center)
        this.ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        this.ctx.fillStyle = fill;
        this.ctx.fillText(text, 0, 0);
        
        this.ctx.restore();

        // Create texture from canvas
        const imageBitmap = await createImageBitmap(this.canvas);
        const texture = this.device.createTexture({
            size: [canvasWidth, canvasHeight],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });

        this.device.queue.copyExternalImageToTexture(
            { source: imageBitmap },
            { texture: texture },
            [canvasWidth, canvasHeight]
        );

        const textureData = {
            texture,
            width: canvasWidth,
            height: canvasHeight,
        };

        this.textCache.set(cacheKey, textureData);
        return textureData;
    }

    // Add text instance
    async addText(x, y, text, style = {}) {
        const textureData = await this.renderTextToTexture(text, style, 0, false);
        
        this.textInstances.push({
            position: [x + textureData.width / 2, y + textureData.height / 2],
            size: [textureData.width, textureData.height],
            texCoord: [0, 0],
            texSize: [1, 1],
            textureData,
        });
    }

    // Add rotated text (rotation in radians)
    async addTextRotated(x, y, text, style = {}, rotation = 0, flipVertical = false) {
        // Render text with rotation applied to the texture itself
        const textureData = await this.renderTextToTexture(text, style, rotation, flipVertical);
        
        // Center the position (text is centered in texture, so position should be centered too)
        this.textInstances.push({
            position: [x, y],
            size: [textureData.width, textureData.height],
            texCoord: [0, 0],
            texSize: [1, 1],
            textureData,
            rotation: 0, // Rotation already applied to texture
        });
    }

    clear() {
        this.textInstances = [];
    }

    // Render all text instances
    render(encoder, renderPass) {
        if (this.textInstances.length === 0) return;

        const uniformBindGroup = this.device.createBindGroup({
            layout: this.textPipeline.getBindGroupLayout(0),
            entries: [
                {
                    binding: 0,
                    resource: {
                        buffer: this.core.projectionBuffer,
                    },
                },
            ],
        });

        // Group instances by texture to minimize texture switches
        const instancesByTexture = new Map();
        for (let i = 0; i < this.textInstances.length; i++) {
            const inst = this.textInstances[i];
            const texKey = inst.textureData.texture;
            if (!instancesByTexture.has(texKey)) {
                instancesByTexture.set(texKey, []);
            }
            instancesByTexture.get(texKey).push({ instance: inst, index: i });
        }

        // Render each texture group
        for (const [texture, instances] of instancesByTexture) {
            const instanceData = new Float32Array(instances.length * 8);
            for (let i = 0; i < instances.length; i++) {
                const inst = instances[i].instance;
                const offset = i * 8;
                instanceData[offset + 0] = inst.position[0];
                instanceData[offset + 1] = inst.position[1];
                instanceData[offset + 2] = inst.size[0];
                instanceData[offset + 3] = inst.size[1];
                instanceData[offset + 4] = inst.texCoord[0];
                instanceData[offset + 5] = inst.texCoord[1];
                instanceData[offset + 6] = inst.texSize[0];
                instanceData[offset + 7] = inst.texSize[1];
            }

            if (!this.textBuffer || this.textBuffer.size < instanceData.byteLength) {
                if (this.textBuffer) this.textBuffer.destroy();
                this.textBuffer = this.device.createBuffer({
                    size: instanceData.byteLength,
                    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
                });
            }

            this.device.queue.writeBuffer(this.textBuffer, 0, instanceData);

            const textureBindGroup = this.device.createBindGroup({
                layout: this.textPipeline.getBindGroupLayout(1),
                entries: [
                    {
                        binding: 0,
                        resource: texture.createView(),
                    },
                    {
                        binding: 1,
                        resource: this.sampler,
                    },
                ],
            });

            renderPass.setPipeline(this.textPipeline);
            renderPass.setBindGroup(0, uniformBindGroup);
            renderPass.setBindGroup(1, textureBindGroup);
            renderPass.setVertexBuffer(0, this.textBuffer);
            renderPass.draw(4, instances.length); // 4 vertices per quad
        }
    }

    // Get rendering statistics
    getStats() {
        return {
            textInstances: this.textInstances.length,
        };
    }
}

// Some initial settings.
// Initialize window.data if it doesn't exist
if (!window.data) {
    window.data = {};
}

window.data.zoom = window.data.zoom || 0;

window.data.nucleotideColors = window.data.nucleotideColors || {
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

// WebGPU rendering system
let webgpuCore = null;
let renderer = null;
let textRenderer = null;
let canvas = null;

// Orientation state: 'horizontal' (default, bottom-to-top) or 'vertical' (left-to-right)
window.data.orientation = window.data.orientation || 'horizontal';

// Toggle orientation between horizontal and vertical
function toggleOrientation() {
    window.data.orientation = window.data.orientation === 'horizontal' ? 'vertical' : 'horizontal';
    repaint();
}

// Helper functions to convert coordinates based on orientation
function getBasesPerPixel(main) {
    if (window.data.orientation === 'horizontal') {
        return (window.data.locus_end - window.data.locus_start) / (main.offsetHeight - 20 - 20 - 35);
    } else {
        return (window.data.locus_end - window.data.locus_start) / (main.offsetWidth - 200);
    }
}

function getGenomicPosition(genomicPos, basesPerPixel) {
    if (window.data.orientation === 'horizontal') {
        return (window.data.locus_end - genomicPos) / basesPerPixel;
    } else {
        return (genomicPos - window.data.locus_start) / basesPerPixel;
    }
}

function swapCoords(x, y) {
    if (window.data.orientation === 'horizontal') {
        return { x: x, y: y };
    } else {
        return { x: y, y: x };
    }
}

function swapDimensions(width, height) {
    if (window.data.orientation === 'horizontal') {
        return { width: width, height: height };
    } else {
        return { width: height, height: width };
    }
}

// Function to initialize and render the WebGPU application.
async function renderApp() {
    try {
        // Wait for window.data to be available
        if (!window.data) {
            console.error('window.data is not available');
            return;
        }

    // Get main HTMLElement.
    var main = document.querySelector('main');
        if (!main) {
            console.error('main element not found');
            return;
        }

        // Create canvas
        canvas = document.createElement('canvas');
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.display = 'block';
        main.appendChild(canvas);

        // Initialize WebGPU
        webgpuCore = new WebGPUCore();
        await webgpuCore.init(canvas);
        
        // Make webgpuCore globally accessible for export function
        window.webgpuCore = webgpuCore;
        
        renderer = new InstancedRenderer(webgpuCore);
        textRenderer = new TextRenderer(webgpuCore);

    window.data.locus_start = window.data.ref_start;
    window.data.locus_end = window.data.ref_end;

    // Set up element caches
    window.data.uiElements = {};
    window.data.sampleElements = {};

    // Listen for window resize events.
    window.addEventListener('resize', debounce(resize));

        await repaint();
    } catch (error) {
        console.error('Error in renderApp:', error);
        alert('Failed to initialize visualization: ' + error.message);
    }
}

// Mouse interactions removed as requested

document.addEventListener('wheel', function(event) {
    // Prevent default scrolling
    event.preventDefault();
    
    // Determine the zoom factor
    const zoomFactor = event.deltaY < 0 ? (event.shiftKey ? 0.99 : 0.9) : (event.shiftKey ? 1.01 : 1.1);

    // Get the genomic position under the mouse cursor
    const mouseGenomicPos = getGenomicPositionFromEvent(event);
    
    // Calculate the new locus range based on the zoom factor
    const range = window.data.locus_end - window.data.locus_start;
    const newRange = range * zoomFactor;

    let locusStart, locusEnd;
    const main = document.querySelector('main');
    
    if (mouseGenomicPos !== null && main) {
        // Zoom centered on mouse cursor - keep the point under cursor fixed on screen
        // Get mouse position relative to the main element
        const mainRect = main.getBoundingClientRect();
        const mainX = event.clientX - mainRect.left;
        const mainY = event.clientY - mainRect.top;
        
        if (window.data.orientation === 'horizontal') {
            // For horizontal orientation, Y coordinate maps to genomic position
            const drawingStart = 20;
            const drawingHeight = main.offsetHeight - 20 - 20 - 35;
            const pixelY = mainY - drawingStart;
            
            // Calculate new bases per pixel
            const newBasesPerPixel = newRange / drawingHeight;
            
            // Keep the genomic position at the mouse Y position fixed
            // P = locus_end - (pixelY * basesPerPixel_old)
            // P = locus_end_new - (pixelY * basesPerPixel_new)
            // So: locus_end_new = P + (pixelY * basesPerPixel_new)
            locusEnd = Math.round(mouseGenomicPos + (pixelY * newBasesPerPixel));
            locusStart = Math.round(locusEnd - newRange);
        } else {
            // For vertical orientation, X coordinate maps to genomic position
            const drawingStart = 20;
            const drawingWidth = main.offsetWidth - 200;
            const pixelX = mainX - drawingStart;
            
            // Calculate new bases per pixel
            const newBasesPerPixel = newRange / drawingWidth;
            
            // Keep the genomic position at the mouse X position fixed
            // P = locus_start + (pixelX * basesPerPixel_old)
            // P = locus_start_new + (pixelX * basesPerPixel_new)
            // So: locus_start_new = P - (pixelX * basesPerPixel_new)
            locusStart = Math.round(mouseGenomicPos - (pixelX * newBasesPerPixel));
            locusEnd = Math.round(locusStart + newRange);
        }
    } else {
        // Fallback: zoom centered on middle of current range
        const center = (window.data.locus_start + window.data.locus_end) / 2;
        locusStart = Math.round(center - newRange / 2);
        locusEnd = Math.round(center + newRange / 2);
    }

    // Ensure that the new range is within the reference range
    if (locusStart < window.data.ref_start) {
        locusStart = window.data.ref_start;
        // Adjust end to maintain range if we hit the start boundary
        locusEnd = Math.min(window.data.ref_end, locusStart + newRange);
    }
    if (locusEnd > window.data.ref_end) {
        locusEnd = window.data.ref_end;
        // Adjust start to maintain range if we hit the end boundary
        locusStart = Math.max(window.data.ref_start, locusEnd - newRange);
    }

    // If range is greater than the minimum range, allow the repaint to happen
    if (locusEnd - locusStart >= 10) {
        window.data.locus_start = locusStart;
        window.data.locus_end = locusEnd;

        // Redraw the screen contents
        repaint();
    }
});

// Panning state
let isPanning = false;
let panStartX = 0;
let panStartY = 0;
let panStartLocusStart = 0;
let panStartLocusEnd = 0;

// Mouse drag panning
document.addEventListener('mousedown', function(event) {
    // Only start panning if clicking on main area (not on footer, aside, context menu, etc.)
    const target = event.target;
    const main = document.querySelector('main');
    if (target.closest('main') && !target.closest('footer') && !target.closest('aside') && !target.closest('#contextMenu')) {
        // Check if it's a left mouse button (button 0)
        if (event.button === 0) {
            isPanning = true;
            panStartX = event.clientX;
            panStartY = event.clientY;
            panStartLocusStart = window.data.locus_start;
            panStartLocusEnd = window.data.locus_end;
            if (main) {
                main.classList.add('panning');
            }
            event.preventDefault();
        }
    }
});

document.addEventListener('mousemove', function(event) {
    if (isPanning) {
        const main = document.querySelector('main');
        if (!main || !window.data) {
            return;
        }
        
        const deltaX = event.clientX - panStartX;
        const deltaY = event.clientY - panStartY;
        
        // Calculate bases per pixel
        let basesPerPixel;
        let panDelta;
        
        if (window.data.orientation === 'horizontal') {
            // For horizontal orientation, Y coordinate maps to genomic position
            const drawingHeight = main.offsetHeight - 20 - 20 - 35;
            basesPerPixel = (panStartLocusEnd - panStartLocusStart) / drawingHeight;
            panDelta = -deltaY * basesPerPixel; // Negative because Y increases downward
        } else {
            // For vertical orientation, X coordinate maps to genomic position
            const drawingWidth = main.offsetWidth - 200;
            basesPerPixel = (panStartLocusEnd - panStartLocusStart) / drawingWidth;
            panDelta = deltaX * basesPerPixel;
        }
        
        // Calculate new locus range
        const range = panStartLocusEnd - panStartLocusStart;
        let newLocusStart = panStartLocusStart - panDelta;
        let newLocusEnd = panStartLocusEnd - panDelta;
        
        // Clamp to reference range
        if (newLocusStart < window.data.ref_start) {
            newLocusStart = window.data.ref_start;
            newLocusEnd = newLocusStart + range;
        }
        if (newLocusEnd > window.data.ref_end) {
            newLocusEnd = window.data.ref_end;
            newLocusStart = newLocusEnd - range;
        }
        
        // Update locus range
        window.data.locus_start = Math.round(newLocusStart);
        window.data.locus_end = Math.round(newLocusEnd);
        
        // Redraw
        repaint();
    }
});

document.addEventListener('mouseup', function(event) {
    if (isPanning && event.button === 0) {
        isPanning = false;
        const main = document.querySelector('main');
        if (main) {
            main.classList.remove('panning');
        }
    }
});

// Also handle mouse leave to stop panning if mouse leaves window
document.addEventListener('mouseleave', function() {
    if (isPanning) {
        isPanning = false;
        const main = document.querySelector('main');
        if (main) {
            main.classList.remove('panning');
        }
    }
});

// Arrow key panning state
let arrowKeyPanInterval = null;
let arrowKeyPanDirection = null;

function performArrowKeyPan() {
    const main = document.querySelector('main');
    if (!main || !window.data || !arrowKeyPanDirection) {
        return;
    }
    
    // Calculate pan distance (2% of current range for smoother scrolling)
    const range = window.data.locus_end - window.data.locus_start;
    const panDistance = range * 0.02;
    
    let panDelta = 0;
    
    if (window.data.orientation === 'horizontal') {
        // For horizontal orientation, up/down arrows pan
        if (arrowKeyPanDirection === 'up') {
            panDelta = -panDistance; // Arrow up = move view up = decrease genomic position
        } else if (arrowKeyPanDirection === 'down') {
            panDelta = panDistance; // Arrow down = move view down = increase genomic position
        }
    } else {
        // For vertical orientation, left/right arrows pan
        if (arrowKeyPanDirection === 'left') {
            panDelta = panDistance; // Arrow left = move view left = show earlier positions = increase locus
        } else if (arrowKeyPanDirection === 'right') {
            panDelta = -panDistance; // Arrow right = move view right = show later positions = decrease locus
        }
    }
    
    if (panDelta !== 0) {
        let newLocusStart = window.data.locus_start - panDelta;
        let newLocusEnd = window.data.locus_end - panDelta;
        
        // Clamp to reference range
        if (newLocusStart < window.data.ref_start) {
            newLocusStart = window.data.ref_start;
            newLocusEnd = newLocusStart + range;
        }
        if (newLocusEnd > window.data.ref_end) {
            newLocusEnd = window.data.ref_end;
            newLocusStart = newLocusEnd - range;
        }
        
        // Update locus range
        window.data.locus_start = Math.round(newLocusStart);
        window.data.locus_end = Math.round(newLocusEnd);
        
        // Redraw
        repaint();
    }
}

function stopArrowKeyPan() {
    if (arrowKeyPanInterval) {
        clearInterval(arrowKeyPanInterval);
        arrowKeyPanInterval = null;
    }
    arrowKeyPanDirection = null;
}

// Arrow key panning
document.addEventListener('keydown', function(event) {
    // Handle arrow keys for panning
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
        // Prevent default scrolling
        event.preventDefault();
        
        // If already panning in this direction, don't restart
        let newDirection = null;
        if (window.data.orientation === 'horizontal') {
            if (event.key === 'ArrowUp') {
                newDirection = 'up';
            } else if (event.key === 'ArrowDown') {
                newDirection = 'down';
            }
        } else {
            if (event.key === 'ArrowLeft') {
                newDirection = 'left';
            } else if (event.key === 'ArrowRight') {
                newDirection = 'right';
            }
        }
        
        if (newDirection && newDirection !== arrowKeyPanDirection) {
            stopArrowKeyPan();
            arrowKeyPanDirection = newDirection;
            
            // Perform initial pan immediately
            performArrowKeyPan();
            
            // Then continue panning at regular intervals for smooth continuous scrolling
            arrowKeyPanInterval = setInterval(performArrowKeyPan, 16); // ~60fps
        }
        return;
    }
    
    // Handle the '+' or '-' key press event for zooming
    if (event.key === '+' || event.key === '=' || event.key === '-') {
        const zoomFactor = (event.key === '+' || event.key === '=') ? 0.9 : 1.1;

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
        
        event.preventDefault();
    }
});

// Stop arrow key panning when key is released
document.addEventListener('keyup', function(event) {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
        stopArrowKeyPan();
    }
});

// Also stop panning if window loses focus
window.addEventListener('blur', function() {
    stopArrowKeyPan();
});

// Helper function to prevent an in-progress event handler from firing again while the first is in progress.
function debounce(func) {
    var timer;
    return function(event){
        if (timer) clearTimeout(timer);
        timer = setTimeout(func,100,event);
    };
}

// Resize function window with check to prevent concurrent executions
function resize() {
    window.data.uiElements = {};
    repaint();
}

// Resize function window
// Make repaint available globally so toggleOrientation can call it
window.repaint = async function repaint() {
    if (!webgpuCore || !renderer || !textRenderer) return;
    
    // Start timing
    const renderStartTime = performance.now();
    
    var main = document.querySelector('main');

    // Handle resize
    webgpuCore.handleResize();
    
    // Clear renderer
    renderer.clear();
    textRenderer.clear();

    // Draw all the elements
    await drawIdeogram(main, window.data.ideogram);
    await drawRuler(main);
    await drawGenes(main, window.data.genes);
    await drawReference(main, window.data.ref);
    await drawSamples(main, window.data.samples);
    
    // Render everything
    const encoder = webgpuCore.createCommandEncoder();
    const texture = webgpuCore.getCurrentTexture();
    const renderPass = encoder.beginRenderPass({
        colorAttachments: [{
            view: texture.createView(),
            clearValue: { r: 1.0, g: 1.0, b: 1.0, a: 1.0 },
            loadOp: 'clear',
            storeOp: 'store',
        }],
    });
    
    renderer.render(encoder, renderPass);
    textRenderer.render(encoder, renderPass);
    
    renderPass.end();
    webgpuCore.submit([encoder.finish()]);
    
    // End timing and update status bar
    const renderEndTime = performance.now();
    const renderTime = renderEndTime - renderStartTime;
    
    // Get stats from renderers
    const polygonStats = renderer.getStats();
    const textStats = textRenderer.getStats();
    
    // Update status bar
    updateStatusBar(renderTime, polygonStats, textStats);
}

// Function to update the status bar with GPU stats
function updateStatusBar(renderTime, polygonStats, textStats) {
    const renderTimeEl = document.getElementById('renderTime');
    const shapeCountEl = document.getElementById('shapeCount');
    
    if (renderTimeEl) {
        renderTimeEl.textContent = renderTime.toFixed(2) + ' ms';
    }
    
    // Calculate total shapes (rectangles + triangles + lines)
    const totalShapes = polygonStats.rectangles + polygonStats.triangles + polygonStats.lines;
    if (shapeCountEl) {
        shapeCountEl.textContent = totalShapes.toLocaleString();
    }
    
    // Show status bar when updated
    if (typeof window.showStatusBar === 'function') {
        window.showStatusBar();
    }
}

// Function to draw the ideogram.
async function drawIdeogram(main, ideogramData) {
        const ideoLength = ideogramData.columns[2].values[ideogramData.columns[2].values.length - 1];
        const ideoWidth = 18;
    const ideoSize = window.data.orientation === 'horizontal' ? (main.offsetHeight - 150) : (main.offsetWidth - 200);
        const ideoX = 15;
        const ideoY = 40;

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

    let bandPos = ideoY;
    let acenSeen = false;
    for (let i = ideogramData.columns[0].values.length - 1; i >= 0; i--) {
        let bandSize = (ideogramData.columns[2].values[i] - ideogramData.columns[1].values[i]) * ideoSize / ideoLength;
        let bandStart = ideogramData.columns[1].values[i];
        let bandEnd = ideogramData.columns[2].values[i];
        let bandName = ideogramData.columns[3].values[i];
        let bandStain = ideogramData.columns[4].values[i];
        let bandColor = ideogramData.columns[5].values[i];

        if (bandStain == 'acen') {
            // Draw centromere triangles
            const rectCoords = swapCoords(ideoX, bandPos);
            const rectDims = swapDimensions(ideoWidth, bandSize);
            renderer.addRect(rectCoords.x, rectCoords.y, rectDims.width, rectDims.height, "#ffffff");

            if (!acenSeen) {
                if (window.data.orientation === 'horizontal') {
                    renderer.addTriangle(
                        ideoX, bandPos,
                        ideoX + ideoWidth - 0.5, bandPos,
                        ideoX + (ideoWidth / 2), bandPos + bandSize,
                        bandColor
                    );
                } else {
                    renderer.addTriangle(
                        bandPos, ideoX,
                        bandPos, ideoX + ideoWidth - 0.5,
                        bandPos + bandSize, ideoX + (ideoWidth / 2),
                        bandColor
                    );
                }
            } else {
                if (window.data.orientation === 'horizontal') {
                    renderer.addTriangle(
                        ideoX, bandPos + bandSize,
                        ideoX + ideoWidth - 0.5, bandPos + bandSize,
                        ideoX + (ideoWidth / 2), bandPos,
                        bandColor
                    );
                } else {
                    renderer.addTriangle(
                        bandPos + bandSize, ideoX,
                        bandPos + bandSize, ideoX + ideoWidth - 0.5,
                        bandPos, ideoX + (ideoWidth / 2),
                        bandColor
                    );
                }
            }
            acenSeen = true;
        } else {
            // Draw non-centromeric rectangles
            const rectCoords = swapCoords(ideoX, bandPos);
            const rectDims = swapDimensions(ideoWidth, bandSize);
            renderer.addRect(rectCoords.x, rectCoords.y, rectDims.width, rectDims.height, bandColor);

            // Draw band label if it fits
            const labelText = bandName;
            const labelWidth = labelText.length * 7; // Approximate width
            if (labelWidth <= 0.9*bandSize) {
                const textCoords = swapCoords(ideoX + ideoWidth / 2, bandPos + bandSize / 2);
                const rotation = window.data.orientation === 'horizontal' ? -Math.PI / 2 : 0;
                await textRenderer.addTextRotated(
                    textCoords.x,
                    textCoords.y,
                    labelText,
                    {
                        fontFamily: 'Helvetica',
                        fontSize: 7,
                        fill: invertColor(bandColor),
                        align: 'center'
                    },
                    rotation
                );
            }
        }

        bandPos += bandSize;
        }

        // Draw outer rectangle of ideogram
    const outerRectCoords = swapCoords(ideoX, ideoY);
    const outerRectDims = swapDimensions(ideoWidth, ideoSize);
    renderer.addRect(outerRectCoords.x, outerRectCoords.y, outerRectDims.width, outerRectDims.height, 0xffffff);

        // Draw chromosome name
    const nameCoords = swapCoords(17, window.data.orientation === 'horizontal' ? (main.offsetHeight - 70) : (main.offsetWidth - 70));
    const nameRotation = window.data.orientation === 'horizontal' ? -Math.PI / 2 : 0;
    await textRenderer.addTextRotated(nameCoords.x, nameCoords.y, ideogramData.columns[0].values[0], {
                fontFamily: 'Helvetica',
                fontSize: 12,
        fill: '#000000',
                align: 'center',
    }, nameRotation);

        // Draw selected region
    const selectionPos = (ideoLength - window.data.locus_end) * ideoSize / ideoLength;
    const selectionSize = (window.data.locus_end - window.data.locus_start) * ideoSize / ideoLength;
    const selCoords = swapCoords(ideoX - 5, ideoY + selectionPos);
    const selDims = swapDimensions(ideoWidth + 10, selectionSize < 3 ? 3 : selectionSize);
    renderer.addRect(selCoords.x, selCoords.y, selDims.width, selDims.height, "#ff000055");
}

async function drawRuler(main) {
    const basesPerPixel = getBasesPerPixel(main);

    // Draw axis line
    let axisStart, axisEnd, axisPos;
    if (window.data.orientation === 'horizontal') {
        // Horizontal orientation: vertical line (constant X, varying Y)
        // In horizontal mode, we want: x=105 (constant), y varies from 20 to axisEnd
        axisStart = 20;
        axisEnd = main.offsetHeight - 35;
        axisPos = 105; // X position for vertical line
        const lineCoords1 = swapCoords(axisPos, axisStart);
        const lineCoords2 = swapCoords(axisPos, axisEnd);
        renderer.addLine(lineCoords1.x, lineCoords1.y, lineCoords2.x, lineCoords2.y, 0x555555);
    } else {
        // Vertical orientation: horizontal line (varying X, constant Y)
        // In vertical mode, swapCoords swaps x and y, so we pass (Y, X) to get (X, Y) after swap
        axisStart = 20;
        axisEnd = main.offsetWidth - 200;
        axisPos = 40; // Y position for horizontal line
        // Pass (Y, X) so after swap we get (X, Y)
        const lineCoords1 = swapCoords(axisPos, axisStart);
        const lineCoords2 = swapCoords(axisPos, axisEnd);
        renderer.addLine(lineCoords1.x, lineCoords1.y, lineCoords2.x, lineCoords2.y, 0x555555);
    }

    // Display range
    const rangeText = window.data.locus_start.toLocaleString() + " - " + window.data.locus_end.toLocaleString() + 
          " (" + (window.data.locus_end - window.data.locus_start).toLocaleString() + " bp)";
    let textCoords;
    if (window.data.orientation === 'horizontal') {
        textCoords = swapCoords(108, axisStart + (axisEnd - axisStart)/2);
    } else {
        textCoords = swapCoords(axisStart + (axisEnd - axisStart)/2, axisPos - 15);
    }
    const rotation = window.data.orientation === 'horizontal' ? -Math.PI / 2 : 0;
    await textRenderer.addTextRotated(textCoords.x, textCoords.y, rangeText, {
            fontFamily: 'Helvetica',
            fontSize: 9,
        fill: '#000000',
            align: 'center',
    }, rotation);

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
        let ticGenomicPos = getGenomicPosition(currentTic, basesPerPixel);

        if ((window.data.orientation === 'horizontal' && ticGenomicPos >= axisStart && ticGenomicPos <= axisEnd) ||
            (window.data.orientation === 'vertical' && ticGenomicPos >= axisStart && ticGenomicPos <= axisEnd)) {
            let ticLineCoords1, ticLineCoords2, textPos;
            if (window.data.orientation === 'horizontal') {
                // Horizontal orientation: horizontal tic marks (perpendicular to vertical axis line)
                // Constant X range (102-108), varying Y (ticGenomicPos)
                ticLineCoords1 = swapCoords(102, ticGenomicPos);
                ticLineCoords2 = swapCoords(108, ticGenomicPos);
                textPos = swapCoords(52, ticGenomicPos - 5.5);
            } else {
                // Vertical orientation: vertical tic marks (perpendicular to horizontal axis line)
                // Varying X (ticGenomicPos), constant Y range around axisPos
                // swapCoords swaps x and y, so pass (Y, X) to get (X, Y) after swap
                ticLineCoords1 = swapCoords(axisPos - 3, ticGenomicPos);
                ticLineCoords2 = swapCoords(axisPos + 3, ticGenomicPos);
                textPos = swapCoords(axisPos - 15, ticGenomicPos);
            }
            renderer.addLine(ticLineCoords1.x, ticLineCoords1.y, ticLineCoords2.x, ticLineCoords2.y, 0x555555);

            await textRenderer.addText(textPos.x, textPos.y, currentTic.toLocaleString(), {
                    fontFamily: 'Helvetica',
                    fontSize: 9,
                fill: '#000000',
                    align: 'right',
            });
        }

        currentTic += ticIncrement;
    }
}

async function drawGenes(main, geneData) {
    const basesPerPixel = getBasesPerPixel(main);
    const geneX = 130;

    for (let geneIdx = 0; geneIdx < geneData.columns[0].values.length; geneIdx++) {
        let txStart = geneData.columns[4].values[geneIdx];
        let txEnd = geneData.columns[5].values[geneIdx];
        let geneName = geneData.columns[12].values[geneIdx];
        let geneStrand = geneData.columns[3].values[geneIdx];

        let geneBarStart = getGenomicPosition(txStart, basesPerPixel);
        let geneBarEnd = getGenomicPosition(txEnd, basesPerPixel);

        // Draw gene line
        const lineCoords1 = swapCoords(geneX, geneBarStart);
        const lineCoords2 = swapCoords(geneX, geneBarEnd);
        renderer.addLine(lineCoords1.x, lineCoords1.y, lineCoords2.x, lineCoords2.y, 0x0000ff);

        // Draw strand lines
        for (let txPos = txStart + 200; txPos <= txEnd - 200; txPos += 500) {
            let featherPos = getGenomicPosition(txPos, basesPerPixel);
            let featherOffset = geneStrand == '+' ? 5 : -5;
            let featherEndPos = featherPos + featherOffset;
            
            if (window.data.orientation === 'horizontal') {
                renderer.addLine(geneX, featherPos, geneX - 3, featherEndPos, 0x0000ff);
                renderer.addLine(geneX, featherPos, geneX + 3, featherEndPos, 0x0000ff);
            } else {
                renderer.addLine(featherPos, geneX, featherEndPos, geneX - 3, 0x0000ff);
                renderer.addLine(featherPos, geneX, featherEndPos, geneX + 3, 0x0000ff);
            }
        }

        // Draw gene name
        const nameCoords = swapCoords(geneX + 3, geneBarStart + (Math.abs(geneBarEnd - geneBarStart) / 2));
        const rotation = window.data.orientation === 'horizontal' ? -Math.PI / 2 : 0;
        await textRenderer.addTextRotated(nameCoords.x, nameCoords.y, geneName, {
                fontFamily: 'Helvetica',
                fontSize: 9,
            fill: '#000000',
                align: 'center',
        }, rotation);

        // Draw exons
        let exonStarts = geneData.columns[9].values[geneIdx].split(',').filter(Boolean);
        let exonEnds = geneData.columns[10].values[geneIdx].split(',').filter(Boolean);

        for (let exonIdx = 0; exonIdx < exonStarts.length; exonIdx++) {
            const exonStartPos = getGenomicPosition(exonStarts[exonIdx], basesPerPixel);
            const exonEndPos = getGenomicPosition(exonEnds[exonIdx], basesPerPixel);
            const exonSize = Math.abs(exonEndPos - exonStartPos);
            
            const exonCoords = swapCoords(geneX - 5, exonStartPos);
            const exonDims = swapDimensions(10, exonSize);
            renderer.addRect(exonCoords.x, exonCoords.y, exonDims.width, exonDims.height, 0x0000ff);
        }
    }
}

async function drawReference(main, refData) {
    const basesPerPixel = getBasesPerPixel(main);
    const halfBaseHeight = 0.5 / basesPerPixel;

    const nucleotideColors = window.data.nucleotideColors;
    const visibleRange = window.data.locus_end - window.data.locus_start;

    // Only process bases if the visible range is small enough
    if (visibleRange > 1500) {
        return; // Too zoomed out, skip reference rendering
    }

    // Calculate the starting index in the reference data
    // The reference data starts at ref_start, so we need to offset by the visible start
    const refDataStart = window.data.ref_start;
    
    for (let locusPos = window.data.locus_start; locusPos <= window.data.locus_end; locusPos++) {
        // Only process positions within the reference data range
        if (locusPos < refDataStart || locusPos > window.data.ref_end) {
            continue;
        }
        
        // Calculate index into reference data (0-indexed from ref_start)
        const i = locusPos - refDataStart;
        
        // Check bounds
        if (i < 0 || i >= refData.columns[0].values.length) {
            continue;
        }
        
        const base = refData.columns[0].values[i];
        if (!base) continue; // Skip if no base data
        
        const baseColor = nucleotideColors[base];
        if (!baseColor) continue; // Skip if no color mapping

        const genomicPos = getGenomicPosition(locusPos, basesPerPixel);
        const coords = swapCoords(154, genomicPos);
        const dims = swapDimensions(10, 2*halfBaseHeight);
        const textCoords = swapCoords(154, genomicPos);

        // Show text when zoomed in enough (threshold increased to 200 for better visibility)
        if (visibleRange <= 200) {
            // Calculate font size based on available space per base
            // Use most of the vertical space available for each base, but cap at reasonable min/max
            const baseHeight = 2 * halfBaseHeight;
            const fontSize = Math.max(10, Math.min(20, baseHeight * 0.9)); // Scale with base height, between 10-20px
            
            // For horizontal orientation, text should be vertical (rotated 90 degrees clockwise, then flipped)
            // For vertical orientation, text should be horizontal (no rotation)
            if (window.data.orientation === 'horizontal') {
                // Use addTextRotated for vertical text - rotate and flip vertically to mirror
                const rotation = -Math.PI / 2;
                await textRenderer.addTextRotated(textCoords.x, textCoords.y, base, {
                        fontFamily: 'Helvetica',
                        fontSize: fontSize,
                        fontWeight: 'bold',
                    fill: '#' + baseColor.toString(16).padStart(6, '0'),
                        align: 'center',
                }, rotation, true); // flipVertical = true for horizontal orientation
            } else {
                // Use addText for horizontal text (no rotation needed)
                await textRenderer.addText(textCoords.x, textCoords.y, base, {
                        fontFamily: 'Helvetica',
                        fontSize: fontSize,
                        fontWeight: 'bold',
                    fill: '#' + baseColor.toString(16).padStart(6, '0'),
                        align: 'center',
                });
            }
        } else {
            renderer.addRect(coords.x, coords.y - dims.height/2, dims.width, dims.height, baseColor);
        }
    }
}

async function drawSamples(main, sampleData) {
    const sampleDict = {};
    let index = 0;
    for (const sampleName of window.data.samples.columns[9].values) {
        if (!sampleDict.hasOwnProperty(sampleName)) {
            sampleDict[sampleName] = index++;
        }
    }

    for (const [sampleName, sampleIndex] of Object.entries(sampleDict)) {
        await drawSample(main, sampleData, sampleName, sampleIndex);
    }
}

async function drawSample(main, sampleData, sampleName, sampleIndex, sampleWidth=20) {
    const basesPerPixel = getBasesPerPixel(main);
    const halfBaseHeight = 0.5 / basesPerPixel;

    // Calculate track position based on orientation
    let trackPos, trackSize, trackDim1, trackDim2;
    if (window.data.orientation === 'horizontal') {
        trackPos = 185 + (sampleIndex * sampleWidth);
        trackSize = sampleWidth - 5;
        trackDim1 = trackPos;
        trackDim2 = 0;
    } else {
        trackPos = 185 + (sampleIndex * sampleWidth);
        trackSize = sampleWidth - 5;
        trackDim1 = 0;
        trackDim2 = trackPos;
    }
    
    // Draw sample track border
    const borderCoords = swapCoords(trackDim1, trackDim2);
    const borderDims = swapDimensions(trackSize, window.data.orientation === 'horizontal' ? main.offsetHeight : main.offsetWidth);
    renderer.addRect(borderCoords.x, borderCoords.y, borderDims.width, borderDims.height, 0xaaaaaa, 0.0); // No fill, just border

        const elementCache = new Map();
    const elementAlpha = new Map();
    
        for (let i = 0; i < sampleData.columns[10].values.length; i++) {
            let referenceStart = sampleData.columns[3].values[i];
            let referenceEnd = sampleData.columns[4].values[i];
            let rowSampleName = sampleData.columns[9].values[i];
            let elementType = sampleData.columns[10].values[i];
            let sequence = sampleData.columns[11].values[i];

            const elementKey = `${referenceStart}-${referenceEnd}-${rowSampleName}-${elementType}-${sequence}`;

            if (sampleName == rowSampleName && !(referenceEnd < window.data.locus_start || referenceStart > window.data.locus_end)) {
                if (!elementCache.has(elementKey)) {
                const elementGenomicPos = getGenomicPosition(referenceStart, basesPerPixel);
                const elementEndGenomicPos = getGenomicPosition(referenceEnd, basesPerPixel);
                const elementSize = Math.ceil(Math.abs(elementEndGenomicPos - elementGenomicPos));

                    // see alignment.rs for ElementType mapping
                    if (elementType == 1) { // mismatch
                        let color = window.data.nucleotideColors.hasOwnProperty(sequence) ? window.data.nucleotideColors[sequence] : null;
                    if (color !== null) {
                        elementCache.set(elementKey, {
                            type: 'rect',
                            trackPos: trackPos,
                            genomicPos: elementGenomicPos,
                            size: trackSize,
                            length: elementSize,
                            color: color,
                            referenceStart: referenceStart,
                            referenceEnd: referenceEnd
                        });
                        elementAlpha.set(elementKey, 0.1);
                    }
                    } else if (elementType == 2) { // insertion
                    elementCache.set(elementKey, {
                        type: 'rect',
                        trackPos: trackPos,
                        genomicPos: elementGenomicPos,
                        size: trackSize,
                        length: elementSize,
                        color: "#800080",
                        referenceStart: referenceStart,
                        referenceEnd: referenceEnd
                    });
                    elementAlpha.set(elementKey, 0.1);
                    } else if (elementType == 3) { // deletion
                    elementCache.set(elementKey, {
                        type: 'deletion',
                        trackPos: trackPos,
                        genomicPos: elementGenomicPos,
                        size: trackSize,
                        length: elementSize,
                        color: "#ffffff",
                        referenceStart: referenceStart,
                        referenceEnd: referenceEnd
                    });
                    elementAlpha.set(elementKey, 0.1);
                    }
                } else {
                elementAlpha.set(elementKey, Math.min((elementAlpha.get(elementKey) || 0.1) + 0.1, 1.0));
            }
        }
    }

    // Render cached elements
    for (const [elementKey, element] of elementCache.entries()) {
        const alpha = elementAlpha.get(elementKey) || 0.1;
        const visibleRange = window.data.locus_end - element.referenceStart;
            let minVisibility = 0.0;
            if (visibleRange <= 100) {
                minVisibility = 0.0;
            } else if (visibleRange <= 1000) {
                minVisibility = 0.15;
            } else {
                minVisibility = 0.30;
            }

        if (alpha >= minVisibility && !(element.referenceEnd < window.data.locus_start || window.data.locus_end < element.referenceStart)) {
            const elementGenomicPos = getGenomicPosition(element.referenceStart, basesPerPixel);
            const elementEndGenomicPos = getGenomicPosition(element.referenceEnd, basesPerPixel);
            const elementSize = Math.ceil(Math.abs(elementEndGenomicPos - elementGenomicPos));
            
            const coords = swapCoords(element.trackPos, elementGenomicPos);
            const dims = swapDimensions(element.size, elementSize);
            const halfSize = dims.height / 2;

            if (element.type === 'deletion') {
                renderer.addRect(coords.x, coords.y - halfSize, dims.width, dims.height, element.color, alpha);
                const deletionLineCoords = swapCoords(element.trackPos + 6, elementGenomicPos);
                const deletionLineDims = swapDimensions(2, elementSize);
                renderer.addRect(deletionLineCoords.x, deletionLineCoords.y - halfSize, deletionLineDims.width, deletionLineDims.height, "#000000", alpha);
            } else {
                renderer.addRect(coords.x, coords.y - halfSize, dims.width, dims.height, element.color, alpha);
            }
        }
    }
}

// Perform the initial rendering when DOM and data are ready.
// Wait for the data module to set up window.data
function initApp() {
    // Check if window.data exists and is ready
    if (!window.data || !window.data._ready || !window.data.ref_start || !window.data.ref_end) {
        // Retry after a short delay (data module should set this up)
        setTimeout(initApp, 50);
        return;
    }
    
    // Ensure DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            renderApp().catch(err => {
                console.error('Error initializing WebGPU:', err);
                alert('Failed to initialize WebGPU: ' + err.message);
            });
        });
    } else {
        renderApp().catch(err => {
            console.error('Error initializing WebGPU:', err);
            alert('Failed to initialize WebGPU: ' + err.message);
        });
    }
}

// Start initialization after a small delay to ensure data module has run
setTimeout(initApp, 100);
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

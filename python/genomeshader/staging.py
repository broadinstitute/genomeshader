"""
Staging utilities for lazy loading via VM filesystem.
"""
from pathlib import Path
from typing import Union, Any
import json
import os


def get_runs_dir() -> Path:
    """
    Returns the base directory for staging runs.
    
    Uses the current working directory (notebook directory) so files are
    accessible via Jupyter's /files/ route. Uses a non-hidden directory name
    since Jupyter /files/ may not serve hidden directories.
    
    Returns:
        Path: Path to genomeshader_runs in the current working directory
    """
    # Use current working directory (where notebook is running)
    # Use non-hidden directory name (genomeshader_runs instead of .genomeshader_runs)
    # because Jupyter /files/ route may not serve hidden directories
    cwd = Path.cwd()
    cwd_runs = cwd / "genomeshader_runs"
    return cwd_runs


def make_run_dir(run_id: str) -> Path:
    """
    Creates the directory structure for a run.
    
    Args:
        run_id: Unique identifier for the run
        
    Returns:
        Path: Path to the run directory (<runs_dir>/<run_id>/)
    """
    runs_dir = get_runs_dir()
    run_dir = runs_dir / run_id
    tracks_dir = run_dir / "tracks"
    
    # Create directories (including parent runs_dir if needed)
    tracks_dir.mkdir(parents=True, exist_ok=True)
    
    return run_dir


def write_json(path: Path, obj: Union[dict, list, Any]) -> None:
    """
    Writes a dictionary or list to a JSON file with UTF-8 encoding and pretty indentation.
    
    Args:
        path: Path to the JSON file to write
        obj: Dictionary, list, or other JSON-serializable object to write
    """
    # Ensure parent directory exists
    path.parent.mkdir(parents=True, exist_ok=True)
    
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)


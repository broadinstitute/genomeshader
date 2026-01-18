"""
Unit tests for the refactored view.py template-based popup creation.

Note: Tests verify that bootstrap variables (GENOMESHADER_CONFIG, GENOMESHADER_VIEW_ID)
are properly injected into the template for Jupyter comms-based data retrieval.
"""
import os
import json
import re
import pytest
from unittest.mock import Mock, patch, MagicMock
import polars as pl

# Add parent directory to path for imports
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from genomeshader.view import GenomeShader


class TestTemplateLoading:
    """Test template loading functionality."""
    
    @pytest.fixture
    def mock_genomeshader(self):
        """Create a mock GenomeShader instance."""
        with patch('genomeshader.view.gs._init') as mock_init, \
             patch('genomeshader.view.requests.get') as mock_get:
            mock_session = Mock()
            mock_init.return_value = mock_session
            # Mock the genome build validation request
            mock_get.return_value.status_code = 200
            mock_get.return_value.json.return_value = {'ucscGenomes': {'hg38': {}}}
            
            gs = GenomeShader(
                genome_build='hg38',
                gcs_session_dir='gs://test-bucket/genomeshader'
            )
            gs._session = mock_session
            return gs
    
    def test_load_template_html_exists(self, mock_genomeshader):
        """Test that template can be loaded."""
        template = mock_genomeshader._load_template_html()
        assert isinstance(template, str)
        assert len(template) > 0
        assert '<!doctype html>' in template.lower() or '<html' in template.lower()
    
    def test_template_contains_bootstrap_marker(self, mock_genomeshader):
        """Test that template contains the bootstrap marker."""
        template = mock_genomeshader._load_template_html()
        assert '<!--__GENOMESHADER_BOOTSTRAP__-->' in template


class TestRenderMethod:
    """Test the refactored render() method."""
    
    @pytest.fixture
    def mock_genomeshader(self):
        """Create a mock GenomeShader instance."""
        with patch('genomeshader.view.gs._init') as mock_init, \
             patch('genomeshader.view.requests.get') as mock_get:
            mock_session = Mock()
            mock_init.return_value = mock_session
            # Mock the genome build validation request
            mock_get.return_value.status_code = 200
            mock_get.return_value.json.return_value = {'ucscGenomes': {'hg38': {}}}
            
            gs = GenomeShader(
                genome_build='hg38',
                gcs_session_dir='gs://test-bucket/genomeshader'
            )
            gs._session = mock_session
            return gs
    
    @pytest.fixture
    def sample_dataframe(self):
        """Create a sample DataFrame for testing."""
        return pl.DataFrame({
            'reference_contig': ['chr1', 'chr1', 'chr1'],
            'reference_start': [1000, 2000, 3000],
            'reference_end': [1500, 2500, 3500],
            'sample_name': ['sample1', 'sample2', 'sample3'],
        })
    
    def test_render_with_dataframe(self, mock_genomeshader, sample_dataframe):
        """Test render() with a DataFrame input."""
        html_output = mock_genomeshader.render(sample_dataframe)
        
        # Should return a string
        assert isinstance(html_output, str)
        assert len(html_output) > 0
        
        # Should contain inline HTML structure (div container)
        assert '<div id="genomeshader-root-' in html_output
        assert '</div>' in html_output
        # Should contain bootstrap script with comms-based variables
        assert 'window.GENOMESHADER_CONFIG' in html_output
        assert 'window.GENOMESHADER_VIEW_ID' in html_output
    
    def test_render_uses_genomeshader_window_name(self, mock_genomeshader, sample_dataframe):
        """Test that container ID follows genomeshader-root pattern."""
        html_output = mock_genomeshader.render(sample_dataframe)
        
        # Should use 'genomeshader-root-' prefix for container ID
        assert 'genomeshader-root-' in html_output
        # Should contain container ID in mount script
        assert 'getElementById' in html_output
    
    def test_render_injects_bootstrap(self, mock_genomeshader, sample_dataframe):
        """Test that bootstrap snippet is injected into template."""
        html_output = mock_genomeshader.render(sample_dataframe)
        
        # Should contain bootstrap variables directly in inline script
        assert 'window.GENOMESHADER_CONFIG' in html_output
        assert 'window.GENOMESHADER_VIEW_ID' in html_output
        
        # Should contain config fields
        assert 'region' in html_output
        assert 'genome_build' in html_output
        # Should contain comm_available flag for Jupyter comms
        assert 'comm_available' in html_output
    
    def test_render_view_id_construction(self, mock_genomeshader, sample_dataframe):
        """Test that view ID is set correctly for Jupyter comms."""
        html_output = mock_genomeshader.render(sample_dataframe)
        
        # Extract the view ID from the inline script
        view_id_match = re.search(r'window\.GENOMESHADER_VIEW_ID\s*=\s*([^;]+)', html_output)
        assert view_id_match is not None, "Should find view ID in HTML"
        
        view_id_value = view_id_match.group(1).strip()
        # Should be JSON-encoded, so parse it
        view_id_value = json.loads(view_id_value)
        # View ID should be a non-empty string
        assert isinstance(view_id_value, str)
        assert len(view_id_value) > 0
    
    def test_render_config_contains_region(self, mock_genomeshader, sample_dataframe):
        """Test that config contains the region."""
        html_output = mock_genomeshader.render(sample_dataframe)
        
        # Should contain region in format chr:start-end in HTML
        assert 'chr1:1000-3500' in html_output or '"chr1:1000-3500"' in html_output
    
    def test_render_config_contains_genome_build(self, mock_genomeshader, sample_dataframe):
        """Test that config contains genome_build."""
        html_output = mock_genomeshader.render(sample_dataframe)
        
        # Should contain genome build in HTML
        assert 'hg38' in html_output or '"hg38"' in html_output
    
    def test_render_no_innerhtml_manipulation(self, mock_genomeshader, sample_dataframe):
        """Test that output does NOT contain innerHTML manipulation."""
        html_output = mock_genomeshader.render(sample_dataframe)
        
        # Should NOT contain old innerHTML approach (though template might use it internally)
        # The key is that we're not using innerHTML to inject the entire page
        assert 'document.body.innerHTML' not in html_output
    
    def test_render_uses_inline_html(self, mock_genomeshader, sample_dataframe):
        """Test that output uses inline HTML approach."""
        html_output = mock_genomeshader.render(sample_dataframe)
        
        # Should use inline HTML (div container)
        assert '<div id="genomeshader-root-' in html_output
        assert '<style>' in html_output
        assert '<script' in html_output
    
    def test_render_contains_mount_script(self, mock_genomeshader, sample_dataframe):
        """Test that output contains mount script for container initialization."""
        html_output = mock_genomeshader.render(sample_dataframe)
        
        # Should contain mount script that initializes container
        assert 'getElementById' in html_output
        assert 'DOMContentLoaded' in html_output or 'readyState' in html_output
    
    def test_render_with_string_locus(self, mock_genomeshader):
        """Test render() with a string locus (requires mocked get_locus)."""
        # Mock get_locus to return sample data
        sample_df = pl.DataFrame({
            'reference_contig': ['chr1'],
            'reference_start': [1000],
            'reference_end': [2000],
        })
        
        mock_genomeshader.get_locus = Mock(return_value=sample_df)
        
        html_output = mock_genomeshader.render('chr1:1000-2000')
        
        assert isinstance(html_output, str)
        assert len(html_output) > 0
        
        # Should contain bootstrap variables in inline script
        assert 'window.GENOMESHADER_CONFIG' in html_output
        assert 'window.GENOMESHADER_VIEW_ID' in html_output
    
    def test_render_invalid_input(self, mock_genomeshader):
        """Test that render() raises error for invalid input."""
        with pytest.raises(ValueError, match='locus_or_dataframe must be'):
            mock_genomeshader.render(123)  # Invalid type


class TestBootstrapInjection:
    """Test bootstrap snippet injection."""
    
    @pytest.fixture
    def mock_genomeshader(self):
        """Create a mock GenomeShader instance."""
        with patch('genomeshader.view.gs._init') as mock_init, \
             patch('genomeshader.view.requests.get') as mock_get:
            mock_session = Mock()
            mock_init.return_value = mock_session
            # Mock the genome build validation request
            mock_get.return_value.status_code = 200
            mock_get.return_value.json.return_value = {'ucscGenomes': {'hg38': {}}}
            
            gs = GenomeShader(
                genome_build='hg38',
                gcs_session_dir='gs://test-bucket/genomeshader'
            )
            gs._session = mock_session
            return gs
    
    def test_bootstrap_injection_format(self, mock_genomeshader):
        """Test that bootstrap is properly formatted as JavaScript."""
        sample_df = pl.DataFrame({
            'reference_contig': ['chr1'],
            'reference_start': [1000],
            'reference_end': [2000],
        })
        
        html_output = mock_genomeshader.render(sample_df)
        
        # Bootstrap should be valid JavaScript in inline script tags
        assert 'window.GENOMESHADER_CONFIG' in html_output
        assert 'window.GENOMESHADER_VIEW_ID' in html_output
        assert '<script' in html_output
        # Should contain comm_available in config for Jupyter comms
        assert 'comm_available' in html_output


if __name__ == '__main__':
    pytest.main([__file__, '-v'])


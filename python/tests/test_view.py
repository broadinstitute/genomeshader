"""
Unit tests for the refactored view.py template-based popup creation.
"""
import os
import json
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
        
        # Should contain blob URL creation
        assert 'new Blob' in html_output or 'Blob(' in html_output
        assert 'URL.createObjectURL' in html_output
        assert 'window.open' in html_output
    
    def test_render_uses_genomeshader_window_name(self, mock_genomeshader, sample_dataframe):
        """Test that window name is 'genomeshader' not 'newWindow'."""
        html_output = mock_genomeshader.render(sample_dataframe)
        
        # Should use 'genomeshader' as window name
        assert '"genomeshader"' in html_output or "'genomeshader'" in html_output
        # Should NOT use 'newWindow'
        assert '"newWindow"' not in html_output
        assert "'newWindow'" not in html_output
    
    def test_render_injects_bootstrap(self, mock_genomeshader, sample_dataframe):
        """Test that bootstrap snippet is injected into template."""
        html_output = mock_genomeshader.render(sample_dataframe)
        
        # Should contain manifest URL
        assert 'GENOMESHADER_MANIFEST_URL' in html_output
        assert 'gs://test-bucket/genomeshader/manifest.json' in html_output
        
        # Should contain config
        assert 'GENOMESHADER_CONFIG' in html_output
        assert 'region' in html_output
        assert 'genome_build' in html_output
    
    def test_render_manifest_url_construction(self, mock_genomeshader, sample_dataframe):
        """Test that manifest URL is constructed correctly."""
        html_output = mock_genomeshader.render(sample_dataframe)
        
        # Extract the manifest URL from the output
        import re
        manifest_match = re.search(r'GENOMESHADER_MANIFEST_URL\s*=\s*([^;]+)', html_output)
        assert manifest_match is not None
        
        manifest_value = manifest_match.group(1).strip()
        # Should be JSON-encoded, so remove quotes
        manifest_value = json.loads(manifest_value)
        assert manifest_value == 'gs://test-bucket/genomeshader/manifest.json'
    
    def test_render_config_contains_region(self, mock_genomeshader, sample_dataframe):
        """Test that config contains the region."""
        html_output = mock_genomeshader.render(sample_dataframe)
        
        # Should contain region in format chr:start-end
        assert 'chr1:1000-3500' in html_output or '"chr1:1000-3500"' in html_output
    
    def test_render_config_contains_genome_build(self, mock_genomeshader, sample_dataframe):
        """Test that config contains genome_build."""
        html_output = mock_genomeshader.render(sample_dataframe)
        
        # Should contain genome build
        assert 'hg38' in html_output or '"hg38"' in html_output
    
    def test_render_no_innerhtml_manipulation(self, mock_genomeshader, sample_dataframe):
        """Test that output does NOT contain innerHTML manipulation."""
        html_output = mock_genomeshader.render(sample_dataframe)
        
        # Should NOT contain old innerHTML approach
        assert '.innerHTML' not in html_output
        assert 'document.body.innerHTML' not in html_output
        assert 'document.createElement' not in html_output
        assert 'appendChild' not in html_output
    
    def test_render_uses_blob_url(self, mock_genomeshader, sample_dataframe):
        """Test that output uses blob URL approach."""
        html_output = mock_genomeshader.render(sample_dataframe)
        
        # Should use blob URL
        assert 'Blob' in html_output
        assert 'createObjectURL' in html_output
        assert 'text/html' in html_output
    
    def test_render_revokes_blob_url(self, mock_genomeshader, sample_dataframe):
        """Test that blob URL is revoked after delay."""
        html_output = mock_genomeshader.render(sample_dataframe)
        
        # Should revoke URL after delay
        assert 'revokeObjectURL' in html_output
        assert 'setTimeout' in html_output
    
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
        assert 'GENOMESHADER_MANIFEST_URL' in html_output
    
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
        
        # Bootstrap should be valid JavaScript
        assert 'window.GENOMESHADER_MANIFEST_URL' in html_output
        assert 'window.GENOMESHADER_CONFIG' in html_output
        assert '<script>' in html_output or '</script>' in html_output


if __name__ == '__main__':
    pytest.main([__file__, '-v'])


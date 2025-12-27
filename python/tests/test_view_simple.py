"""
Simple unit tests for the refactored view.py template-based popup creation.
Uses unittest (built-in) instead of pytest for easier setup.
"""
import os
import json
import re
import unittest
from unittest.mock import Mock, patch
import polars as pl

# Add parent directory to path for imports
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from genomeshader.view import GenomeShader


class TestTemplateLoading(unittest.TestCase):
    """Test template loading functionality."""
    
    def setUp(self):
        """Set up test fixtures."""
        with patch('genomeshader.view.gs._init') as mock_init, \
             patch('genomeshader.view.requests.get') as mock_get:
            mock_session = Mock()
            mock_init.return_value = mock_session
            # Mock the genome build validation request
            mock_get.return_value.status_code = 200
            mock_get.return_value.json.return_value = {'ucscGenomes': {'hg38': {}}}
            
            self.gs = GenomeShader(
                genome_build='hg38',
                gcs_session_dir='gs://test-bucket/genomeshader'
            )
            self.gs._session = mock_session
    
    def test_load_template_html_exists(self):
        """Test that template can be loaded."""
        template = self.gs._load_template_html()
        self.assertIsInstance(template, str)
        self.assertGreater(len(template), 0)
        self.assertTrue(
            '<!doctype html>' in template.lower() or '<html' in template.lower(),
            "Template should contain HTML doctype or html tag"
        )
    
    def test_template_contains_bootstrap_marker(self):
        """Test that template contains the bootstrap marker."""
        template = self.gs._load_template_html()
        self.assertIn('<!--__GENOMESHADER_BOOTSTRAP__-->', template)


class TestRenderMethod(unittest.TestCase):
    """Test the refactored render() method."""
    
    def setUp(self):
        """Set up test fixtures."""
        with patch('genomeshader.view.gs._init') as mock_init, \
             patch('genomeshader.view.requests.get') as mock_get:
            mock_session = Mock()
            mock_init.return_value = mock_session
            # Mock the genome build validation request
            mock_get.return_value.status_code = 200
            mock_get.return_value.json.return_value = {'ucscGenomes': {'hg38': {}}}
            
            self.gs = GenomeShader(
                genome_build='hg38',
                gcs_session_dir='gs://test-bucket/genomeshader'
            )
            self.gs._session = mock_session
        
        self.sample_df = pl.DataFrame({
            'reference_contig': ['chr1', 'chr1', 'chr1'],
            'reference_start': [1000, 2000, 3000],
            'reference_end': [1500, 2500, 3500],
            'sample_name': ['sample1', 'sample2', 'sample3'],
        })
    
    def test_render_with_dataframe(self):
        """Test render() with a DataFrame input."""
        html_output = self.gs.render(self.sample_df)
        
        # Should return a string
        self.assertIsInstance(html_output, str)
        self.assertGreater(len(html_output), 0)
        
        # Should contain blob URL creation
        self.assertIn('Blob', html_output)
        self.assertIn('createObjectURL', html_output)
        self.assertIn('window.open', html_output)
    
    def test_render_uses_genomeshader_window_name(self):
        """Test that window name is 'genomeshader' not 'newWindow'."""
        html_output = self.gs.render(self.sample_df)
        
        # Should use 'genomeshader' as window name
        self.assertTrue(
            '"genomeshader"' in html_output or "'genomeshader'" in html_output,
            "Should use 'genomeshader' as window name"
        )
        # Should NOT use 'newWindow'
        self.assertNotIn('"newWindow"', html_output)
        self.assertNotIn("'newWindow'", html_output)
    
    def test_render_injects_bootstrap(self):
        """Test that bootstrap snippet is injected into template."""
        html_output = self.gs.render(self.sample_df)
        
        # Should contain manifest URL
        self.assertIn('GENOMESHADER_MANIFEST_URL', html_output)
        self.assertIn('gs://test-bucket/genomeshader/manifest.json', html_output)
        
        # Should contain config
        self.assertIn('GENOMESHADER_CONFIG', html_output)
        self.assertIn('region', html_output)
        self.assertIn('genome_build', html_output)
    
    def test_render_manifest_url_construction(self):
        """Test that manifest URL is constructed correctly."""
        html_output = self.gs.render(self.sample_df)
        
        # Extract the manifest URL from the output
        manifest_match = re.search(r'GENOMESHADER_MANIFEST_URL\s*=\s*([^;]+)', html_output)
        self.assertIsNotNone(manifest_match, "Should find manifest URL in output")
        
        manifest_value = manifest_match.group(1).strip()
        # Should be JSON-encoded, so remove quotes
        manifest_value = json.loads(manifest_value)
        self.assertEqual(manifest_value, 'gs://test-bucket/genomeshader/manifest.json')
    
    def test_render_config_contains_region(self):
        """Test that config contains the region."""
        html_output = self.gs.render(self.sample_df)
        
        # Should contain region in format chr:start-end
        self.assertTrue(
            'chr1:1000-3500' in html_output or '"chr1:1000-3500"' in html_output,
            "Should contain region in config"
        )
    
    def test_render_config_contains_genome_build(self):
        """Test that config contains genome_build."""
        html_output = self.gs.render(self.sample_df)
        
        # Should contain genome build
        self.assertTrue(
            'hg38' in html_output or '"hg38"' in html_output,
            "Should contain genome build in config"
        )
    
    def test_render_no_innerhtml_manipulation(self):
        """Test that output does NOT contain innerHTML manipulation."""
        html_output = self.gs.render(self.sample_df)
        
        # Should NOT contain old innerHTML approach
        self.assertNotIn('.innerHTML', html_output)
        self.assertNotIn('document.body.innerHTML', html_output)
        self.assertNotIn('document.createElement', html_output)
        self.assertNotIn('appendChild', html_output)
    
    def test_render_uses_blob_url(self):
        """Test that output uses blob URL approach."""
        html_output = self.gs.render(self.sample_df)
        
        # Should use blob URL
        self.assertIn('Blob', html_output)
        self.assertIn('createObjectURL', html_output)
        self.assertIn('text/html', html_output)
    
    def test_render_revokes_blob_url(self):
        """Test that blob URL is revoked after delay."""
        html_output = self.gs.render(self.sample_df)
        
        # Should revoke URL after delay
        self.assertIn('revokeObjectURL', html_output)
        self.assertIn('setTimeout', html_output)
    
    def test_render_with_string_locus(self):
        """Test render() with a string locus (requires mocked get_locus)."""
        # Mock get_locus to return sample data
        sample_df = pl.DataFrame({
            'reference_contig': ['chr1'],
            'reference_start': [1000],
            'reference_end': [2000],
        })
        
        self.gs.get_locus = Mock(return_value=sample_df)
        
        html_output = self.gs.render('chr1:1000-2000')
        
        self.assertIsInstance(html_output, str)
        self.assertGreater(len(html_output), 0)
        self.assertIn('GENOMESHADER_MANIFEST_URL', html_output)
    
    def test_render_invalid_input(self):
        """Test that render() raises error for invalid input."""
        with self.assertRaises(ValueError) as context:
            self.gs.render(123)  # Invalid type
        
        self.assertIn('locus_or_dataframe must be', str(context.exception))


class TestBootstrapInjection(unittest.TestCase):
    """Test bootstrap snippet injection."""
    
    def setUp(self):
        """Set up test fixtures."""
        with patch('genomeshader.view.gs._init') as mock_init, \
             patch('genomeshader.view.requests.get') as mock_get:
            mock_session = Mock()
            mock_init.return_value = mock_session
            # Mock the genome build validation request
            mock_get.return_value.status_code = 200
            mock_get.return_value.json.return_value = {'ucscGenomes': {'hg38': {}}}
            
            self.gs = GenomeShader(
                genome_build='hg38',
                gcs_session_dir='gs://test-bucket/genomeshader'
            )
            self.gs._session = mock_session
    
    def test_bootstrap_injection_format(self):
        """Test that bootstrap is properly formatted as JavaScript."""
        sample_df = pl.DataFrame({
            'reference_contig': ['chr1'],
            'reference_start': [1000],
            'reference_end': [2000],
        })
        
        html_output = self.gs.render(sample_df)
        
        # Bootstrap should be valid JavaScript
        self.assertIn('window.GENOMESHADER_MANIFEST_URL', html_output)
        self.assertIn('window.GENOMESHADER_CONFIG', html_output)
        self.assertTrue(
            '<script>' in html_output or '</script>' in html_output,
            "Should contain script tags"
        )


if __name__ == '__main__':
    unittest.main()


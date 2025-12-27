# Tests for genomeshader.view

This directory contains unit tests for the refactored template-based popup creation.

## Setup

Install test dependencies:

```bash
# Install pytest (optional, for test_view.py)
pip install pytest

# Or use the dev requirements
pip install -r ../../dev-requirements.txt
```

## Running Tests

### Using unittest (built-in, no extra dependencies):

```bash
cd python/tests
python3 test_view_simple.py -v
```

### Using pytest (if installed):

```bash
cd python/tests
pytest test_view.py -v
```

Or from the project root:

```bash
pytest python/tests/ -v
```

## Test Coverage

The tests verify:

1. **Template Loading**
   - Template can be loaded successfully
   - Template contains the bootstrap marker

2. **Render Method**
   - Returns valid HTML/JavaScript string
   - Uses blob URL approach (not innerHTML)
   - Window name is 'genomeshader' (not 'newWindow')
   - Bootstrap snippet is injected correctly
   - Manifest URL is constructed correctly
   - Config contains region and genome_build
   - Blob URL is revoked after delay
   - Works with both DataFrame and string locus inputs
   - Raises error for invalid input

3. **Bootstrap Injection**
   - Bootstrap is properly formatted as JavaScript
   - Contains GENOMESHADER_MANIFEST_URL
   - Contains GENOMESHADER_CONFIG


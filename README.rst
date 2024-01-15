genomeshader
""""""""""""

|GitHub release| |PyPI version genomeshader|

.. |GitHub release| image:: https://img.shields.io/github/release/broadinstitute/genomeshader.svg
   :target: https://github.com/broadinstitute/genomeshader/releases/

.. |PyPI version genomeshader| image:: https://img.shields.io/pypi/v/genomeshader.svg
   :target: https://pypi.python.org/pypi/genomeshader/

Genomeshader is a Rust/Python library for rapid visualization of read-level data spanning variants across huge numbers of samples.

Documentation for the API can be found on the `documentation page <https://broadinstitute.github.io/genomeshader/>`_.

Installation
------------

``pip`` is recommended for installation.

::

   pip install genomeshader 


Building from source
--------------------

To build from source, follow the procedure below.

.. code-block:: bash

   # Clone repository.
   git clone https://github.com/broadinstitute/genomeshader.git
   cd genomeshader

   # Create a Python virtual environment and install Maturin.
   # For more information on Maturin, visit https://github.com/PyO3/maturin .
   python -mvenv venv
   . venv/bin/activate
   pip install maturin

   # Build the library (with release optimizations) and install it in
   # the currently active virtual environment.
   maturin develop --release

Supported platforms
-------------------

Genomeshader is compiled for Linux (x86_64) and MacOSX (x86_64, aarch64). Windows support is not currently available.

Getting help
------------

If you encounter bugs or have questions/comments/concerns, please file an issue on our `Github page <https://github.com/broadinstitute/genomeshader/issues>`_.

Developers' guide
-----------------

For information on contributing to Genomeshader development, visit our `developer documentation <DEVELOP.md>`_.

genomeshader
""""""""""""

|GitHub release| |PyPI version genomeshader|

.. |GitHub release| image:: https://img.shields.io/github/release/broadinstitute/genomeshader.svg
   :target: https://github.com/broadinstitute/genomeshader/releases/

.. |PyPI version genomeshader| image:: https://img.shields.io/pypi/v/genomeshader.svg
   :target: https://pypi.python.org/pypi/genomeshader/

Genomeshader is a Rust-backed Python library for rapid visualization of read-level data spanning variants across huge numbers of samples. It is intended for use within Jupyter notebooks.

Documentation for the API can be found on the `documentation page <https://broadinstitute.github.io/genomeshader/>`_.


Prerequisites
-------------

Genomeshader is designed to access local files or data in Google Cloud Storage (GCS). Within certain cloud-computing environments (i.e. Terra, All of Us Researcher Workbench), access to GCS is already configured. For accessing files in GCS on your local machine, you will also need to install the `Google Cloud CLI <https://cloud.google.com/sdk/docs/install-sdk>`_. Then, configure your `Application Default Credentials (ADC) <https://cloud.google.com/docs/authentication/provide-credentials-adc#local-dev>`_.


Installation
------------

``pip`` is recommended for installation.

::

   pip install genomeshader 



Building from source
--------------------

To build from source (particularly for those interested in contributing to the code), follow the procedure below.

.. code-block:: bash

   # Clone repository.
   git clone https://github.com/broadinstitute/genomeshader.git
   cd genomeshader

   # Create a Python virtual environment and install Maturin, the tool that
   # will compile the Rust and Python code into a complete library.
   # For more information on Maturin, visit https://github.com/PyO3/maturin .
   python -mvenv venv
   . venv/bin/activate
   pip install maturin

   # Build the library (with release optimizations) and install it in
   # the currently active virtual environment.
   maturin develop --release

Supported platforms
-------------------

Genomeshader is compiled for Linux and MacOSX. Windows is not currently supported.

Getting help
------------

If you encounter bugs or have questions/comments/concerns, please file an issue on our `Github page <https://github.com/broadinstitute/genomeshader/issues>`_.

Developers' guide
-----------------

For information on contributing to Genomeshader development, visit our `developer documentation <DEVELOP.rst>`_.

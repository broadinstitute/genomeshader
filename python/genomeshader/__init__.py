# __init__.py: genomeshader
# Contact: Kiran V Garimella <kiran@broadinstitute.org>


"""
For detailed documentation and examples, see the README.
"""

import warnings

warnings.simplefilter(action="ignore", category=FutureWarning, append=True)
warnings.filterwarnings("ignore", module="urllib3", append=True)

from .view import *

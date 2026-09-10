"""Guard: the compiled extension must NOT export the symbols of the C libraries
it statically bundles (OpenSSL, libcurl, zlib, bzip2, lzma, htslib).

Those same libraries are loaded elsewhere in a typical Jupyter/genomics process
(Python's ssl/zlib/bz2/lzma, pysam's htslib+OpenSSL, google-cloud-storage's
TLS). If our bundled copies' symbols were exported, they'd be interposed against
the other copies -> two versions of one library sharing symbols in one process
-> a hard native crash (the AoU/Verily kernel segfault on the first gs:// TLS
handshake). `.cargo/config.toml` sets -Wl,--exclude-libs,ALL to keep every
bundled symbol PRIVATE; this test fails if that protection regresses or a newly
bundled lib leaks.
"""
import shutil
import subprocess

import pytest

RISKY = [
    (" SSL_", " EVP_", " OPENSSL_"),          # OpenSSL / libcrypto
    (" curl_easy", " curl_global"),            # libcurl
    (" inflate", " deflate", " crc32", " zlibVersion"),  # zlib
    (" BZ2_",),                                # bzip2
    (" lzma_",),                               # lzma
    (" hts_", " bcf_", " bam_", " sam_", " tbx_", " bgzf_", " htsFile"),  # htslib
]


def _ext_path():
    try:
        import genomeshader.genomeshader as g
    except Exception:
        return None
    p = getattr(g, "__file__", None)
    return p if p and p.endswith(".so") else None


def test_bundled_c_lib_symbols_are_not_exported():
    so = _ext_path()
    if not so:
        pytest.skip("compiled extension not importable / not a .so on this platform")
    if not shutil.which("nm"):
        pytest.skip("nm not available")
    out = subprocess.run(["nm", "-D", "--defined-only", so],
                         capture_output=True, text=True).stdout
    assert "PyInit_genomeshader" in out, "PyInit not exported — module wouldn't import"
    leaks = {}
    for fam in RISKY:
        n = sum(1 for line in out.splitlines() if any(tok in line for tok in fam))
        if n:
            leaks["|".join(t.strip() for t in fam)] = n
    assert not leaks, (
        f"bundled C-library symbols are EXPORTED (collision risk — see "
        f".cargo/config.toml --exclude-libs,ALL): {leaks}")

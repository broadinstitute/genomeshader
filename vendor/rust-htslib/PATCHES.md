This is rust-htslib 0.44.1 with three crash fixes. Genomeshader streams
`gs://` BAM/VCF through htslib; a failed remote open must be a Rust `Err`,
not a SIGSEGV that kills the Jupyter kernel.

1. `bcf::IndexedReader::new` treated `bcf_sr_add_reader`'s `0` (failure) as
   success (`>= 0`). htslib returns 1 on success. A failed `gs://` open then
   dereferenced a NULL header. (`SyncedReader::add_reader` in the same crate
   already checked `res == 0`.) Destroy the synced reader on the error path.
2. `tbx::Reader::new` called `hts_get_format` on a NULL `hts_open` result.
3. `bam::IndexedReader` did not reject a NULL `sam_hdr_read`.

Drop this directory and switch Cargo.toml back to crates.io when an
upstream rust-htslib release includes the same checks.

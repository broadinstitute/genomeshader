# dispatch.py: transport-neutral request dispatch for the viewer.
#
# The viewer sends every backend request through window.__GS_SEND(type, data).
# This module maps each request type to the session method that answers it, so
# the same handlers serve the ipywidgets comm (widget.py) and the local HTTP API
# (server.py). A handler returns the response message (or None for no reply)
# plus optional binary buffers; transports only decide how to deliver it.
from typing import Any, Callable, Dict, List, Optional, Tuple

Response = Tuple[Optional[dict], Optional[List[Any]]]

# Requests that may run slow user code (attach_data closures). Transports run
# these off their receive thread so other traffic isn't blocked.
OFFLOADED_TYPES = frozenset({"fetch_track_data"})


def _fetch_reads(shader, c, rid) -> Response:
    try:
        payload = shader._fetch_reads_payload(
            sample_id=c.get("sample_id"),
            samples=c.get("samples"),
            locus=c.get("locus"),
            bam_url=c.get("bam_url"),
        )
        return {"type": "fetch_reads_response", "request_id": rid, **payload}, None
    except Exception as e:
        hint = shader._report_fetch_failure("reads", e, sample=c.get("sample_id"))
        return {"type": "fetch_reads_error", "request_id": rid,
                "error": str(e), "hint": hint}, None


def _fetch_reads_batch(shader, c, rid) -> Response:
    try:
        results = shader._fetch_reads_batch_payload(c.get("items") or [])
        buffers = None
        if c.get("accept_binary"):
            # Binary columns on the transport's buffer channel. Any chunk the
            # codec cannot represent exactly stays JSON.
            try:
                from . import reads_codec
                results, buffers = reads_codec.encode_batch_items(results)
            except Exception:
                buffers = None
        return {"type": "fetch_reads_batch_response", "request_id": rid,
                "items": results}, buffers or None
    except Exception as e:  # whole-batch failure; per-item errors ride in `items`
        hint = shader._report_fetch_failure("reads", e, sample=None)
        return {"type": "fetch_reads_batch_error", "request_id": rid,
                "error": str(e), "hint": hint}, None


def _fetch_carriers(shader, c, rid) -> Response:
    try:
        carriers = shader.fetch_carriers(
            contig=c.get("contig"),
            pos=c.get("pos"),
            ref=c.get("ref"),
            allele=c.get("allele"),
            track_id=c.get("track_id"),
            strategy=c.get("strategy", "random"),
            n=int(c.get("n", 200)),
        )
        return {"type": "fetch_carriers_response", "request_id": rid, "carriers": carriers}, None
    except Exception as e:
        return {"type": "fetch_carriers_error", "request_id": rid,
                "carriers": [], "error": str(e)}, None


def _fetch_variants(shader, c, rid) -> Response:
    try:
        shader._debug_log("fetch_variants_recv", contig=c.get("contig"),
                          start=c.get("start"), end=c.get("end"))
        payload = shader.fetch_variants_payload(
            c.get("contig"), c.get("start"), c.get("end"),
            sample_ids=c.get("sample_ids"))
        return {"type": "fetch_variants_response", "request_id": rid, **payload}, None
    except Exception as e:
        hint = shader._report_fetch_failure(
            "variants", e, locus=f"{c.get('contig')}:{c.get('start')}-{c.get('end')}")
        return {"type": "fetch_variants_error", "request_id": rid,
                "error": str(e), "hint": hint}, None


def _fetch_track_data(shader, c, rid) -> Response:
    track_id, contig, start, end = c.get("track_id"), c.get("contig"), c.get("start"), c.get("end")
    max_points = c.get("max_points", 2000)
    try:
        payload = shader.fetch_track_data_payload(
            track_id, contig, start, end,
            max_points=max_points if max_points is not None else 2000)
        return {"type": "fetch_track_data_response", "request_id": rid, **payload}, None
    except Exception as e:
        try:
            hint = shader._report_fetch_failure(
                "track_data", e, track_id=track_id, locus=f"{contig}:{start}-{end}")
        except Exception:
            hint = None
        return {"type": "fetch_track_data_error", "request_id": rid,
                "error": str(e), "hint": hint}, None


def _navigate(shader, c, rid) -> Response:
    try:
        # with_variants=False: a jump returns reference/genes fast and defers the
        # cohort-scale variant decode to the frontend viewport loader.
        payload = shader.navigate_payload(
            c.get("contig"), c.get("start"), c.get("end"), with_variants=False)
        return {"type": "navigate_response", "request_id": rid, **payload}, None
    except Exception as e:
        hint = shader._report_fetch_failure(
            "region", e, region=f"{c.get('contig')}:{c.get('start')}-{c.get('end')}")
        return {"type": "navigate_error", "request_id": rid,
                "error": str(e), "hint": hint}, None


def _resolve_feature(shader, c, rid) -> Response:
    try:
        matches = shader.resolve_feature(c.get("query"))
        return {"type": "resolve_feature_response", "request_id": rid, "matches": matches}, None
    except Exception as e:
        return {"type": "resolve_feature_response", "request_id": rid,
                "matches": [], "error": str(e)}, None


def _debug_log(shader, c, rid) -> Response:
    # Fire-and-forget: frontend events land in the server-side debug file.
    try:
        shader._debug_log("frontend." + str(c.get("event", "frontend")), **(c.get("fields") or {}))
    except Exception:
        pass
    return None, None


def _clear_cache(shader, c, rid) -> Response:
    try:
        stats = shader.clear_local_cache()
        return {"type": "clear_cache_response", "request_id": rid, **stats}, None
    except Exception as e:
        return {"type": "clear_cache_error", "request_id": rid, "error": str(e)}, None


def _ucsc_genomes(shader, c, rid) -> Response:
    try:
        info = shader.list_ucsc_genomes()
        return {"type": "ucsc_genomes_response", "request_id": rid,
                "genome_build": getattr(shader, "genome_build", ""),
                "genomes": info.get("genomes", []),
                "default": info.get("default", "")}, None
    except Exception as e:
        return {"type": "ucsc_genomes_response", "request_id": rid,
                "genomes": [], "default": "", "error": str(e)}, None


def _ucsc_list(shader, c, rid) -> Response:
    try:
        payload = shader.list_ucsc_tracks(c.get("genome"))
        tracks = (payload or {}).get("tracks") if isinstance(payload, dict) else payload
        groups = (payload or {}).get("groups") if isinstance(payload, dict) else []
        return {"type": "ucsc_list_response", "request_id": rid,
                "available": payload is not None,
                "genome": c.get("genome"),
                "tracks": tracks or [],
                "groups": groups or []}, None
    except Exception as e:
        return {"type": "ucsc_list_response", "request_id": rid,
                "available": False, "tracks": [], "groups": [], "error": str(e)}, None


def _ucsc_track(shader, c, rid) -> Response:
    try:
        features = shader.ucsc_interval_track(
            c.get("track"), c.get("contig"), int(c.get("start")), int(c.get("end")),
            genome=c.get("genome"))
        return {"type": "ucsc_track_response", "request_id": rid,
                "track": c.get("track"), "label": c.get("label"),
                "features": features}, None
    except Exception as e:
        return {"type": "ucsc_track_error", "request_id": rid,
                "track": c.get("track"), "error": str(e)}, None


def _comments_list(shader, c, rid) -> Response:
    try:
        return {"type": "comments_response", "request_id": rid,
                "author": shader._comment_author(),
                "comments": shader.list_comments()}, None
    except Exception as e:
        return {"type": "comments_response", "request_id": rid,
                "comments": [], "error": str(e)}, None


def _comment_change(action: str, call: Callable[[Any, dict], dict]):
    def handler(shader, c, rid) -> Response:
        try:
            return {"type": "comments_changed", "request_id": rid,
                    "action": action, "comment": call(shader, c)}, None
        except Exception as e:
            return {"type": "comments_changed", "request_id": rid,
                    "action": action, "error": str(e)}, None
    return handler


def _comments_delete(shader, c, rid) -> Response:
    try:
        ok = shader.delete_comment(c.get("id"))
        return {"type": "comments_changed", "request_id": rid,
                "action": "delete", "id": c.get("id"), "ok": ok}, None
    except Exception as e:
        return {"type": "comments_changed", "request_id": rid,
                "action": "delete", "id": c.get("id"), "error": str(e)}, None


def _comments_read_get(shader, c, rid) -> Response:
    try:
        return {"type": "comments_read_state", "request_id": rid,
                "seen": shader.get_comment_read_state()}, None
    except Exception as e:
        return {"type": "comments_read_state", "request_id": rid,
                "seen": {}, "error": str(e)}, None


def _comments_read_set(shader, c, rid) -> Response:
    try:
        ok = shader.set_comment_read_state(c.get("seen") or {})
        return {"type": "comments_read_saved", "request_id": rid, "ok": ok}, None
    except Exception as e:
        return {"type": "comments_read_saved", "request_id": rid, "error": str(e)}, None


HANDLERS: Dict[str, Callable[[Any, dict, Any], Response]] = {
    "fetch_reads": _fetch_reads,
    "fetch_reads_batch": _fetch_reads_batch,
    "fetch_carriers": _fetch_carriers,
    "fetch_variants": _fetch_variants,
    "fetch_track_data": _fetch_track_data,
    "navigate": _navigate,
    "resolve_feature": _resolve_feature,
    "debug_log": _debug_log,
    "clear_cache": _clear_cache,
    "ucsc_genomes": _ucsc_genomes,
    "ucsc_list": _ucsc_list,
    "ucsc_track": _ucsc_track,
    "comments_list": _comments_list,
    "comments_create": _comment_change("create", lambda s, c: s.create_comment(
        c.get("anchor") or {}, c.get("body") or "", author=(c.get("author") or None))),
    "comments_update": _comment_change("update", lambda s, c: s.update_comment(
        c.get("id"), body=c.get("body"), anchor=c.get("anchor"))),
    "comments_reply": _comment_change("reply", lambda s, c: s.reply_comment(
        c.get("id"), body=c.get("body"), author=(c.get("author") or None))),
    "comments_reply_delete": _comment_change("reply_delete", lambda s, c: s.delete_reply(
        c.get("id"), c.get("reply_id"))),
    "comments_read_get": _comments_read_get,
    "comments_read_set": _comments_read_set,
    "comments_delete": _comments_delete,
}


def dispatch(shader, content: dict) -> Response:
    """Answer one viewer request. Returns (response, buffers); response is None
    for fire-and-forget or unknown request types."""
    if not isinstance(content, dict):
        return None, None
    msg_type = content.get("type")
    request_id = content.get("request_id")
    handler = HANDLERS.get(msg_type)
    if handler is None:
        return None, None
    if msg_type != "debug_log":
        try:
            shader._debug_log(
                "comm_recv", type=msg_type, request_id=request_id,
                contig=content.get("contig"), start=content.get("start"),
                end=content.get("end"), sample_id=content.get("sample_id"))
        except Exception:
            pass
    result = handler(shader, content, request_id)
    if msg_type != "debug_log":
        # Resource-usage snapshot (debug mode only; no-op otherwise).
        try:
            shader._debug_log_resources(msg_type)
        except Exception:
            pass
    return result

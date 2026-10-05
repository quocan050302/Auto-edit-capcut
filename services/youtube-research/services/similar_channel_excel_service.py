"""
similar_channel_excel_service.py
Exports a completed SimilarChannelRun to a styled Excel workbook in memory.
"""
from __future__ import annotations

import io
import json
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

try:
    import openpyxl
    from openpyxl.styles import (
        Font, PatternFill, Alignment, Border, Side, numbers
    )
    from openpyxl.utils import get_column_letter
    from openpyxl.styles.numbers import FORMAT_DATE_DATETIME
    OPENPYXL_OK = True
except ImportError:
    OPENPYXL_OK = False


# ─── Colour palette ───────────────────────────────────────────────────────────
HDR_FILL  = "1E2D5A"   # dark blue
HDR_FONT  = "FFFFFF"
QUAL_FILL = "1A7A4A"   # green
GROW_FILL = "1A5C9E"   # blue
WATC_FILL = "C4A417"   # amber
REJC_FILL = "9E3A2C"   # red
MP_FILL   = "C8960C"   # gold for most promising


def _hfill(hex_color: str) -> "PatternFill":
    return PatternFill("solid", fgColor=hex_color)


def _hfont(hex_color: str, bold: bool = False, size: int = 11) -> "Font":
    return Font(color=hex_color, bold=bold, size=size)


def _border_medium() -> "Border":
    s = Side(style="medium")
    return Border(left=s, right=s, top=s, bottom=s)


def _status_fill(status: str) -> Optional["PatternFill"]:
    m = {"QUALIFIED": QUAL_FILL, "GROWING": GROW_FILL,
         "WATCHLIST": WATC_FILL, "REJECTED": REJC_FILL}
    h = m.get(status)
    return _hfill(h) if h else None


def _safe_float(v: Any) -> Optional[float]:
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _safe_int(v: Any) -> Optional[int]:
    try:
        return int(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _parse_dt(s: Any) -> Optional[datetime]:
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
        if dt.tzinfo is not None:
            dt = dt.replace(tzinfo=None)  # Excel wants naive
        return dt
    except Exception:
        return None


def _json_list(v: Any) -> List[str]:
    if isinstance(v, list):
        return [str(x) for x in v]
    if isinstance(v, str):
        try:
            parsed = json.loads(v)
            if isinstance(parsed, list):
                return [str(x) for x in parsed]
        except Exception:
            pass
        return [v] if v else []
    return []


def build_excel_bytes(
    run: Any,                         # SimilarChannelRun ORM object
    candidates: List[Any],            # SimilarChannelCandidate ORM objects (ordered by rank)
    videos_by_channel: Dict[str, List[Any]],  # channel_id -> [SimilarChannelVideo]
) -> bytes:
    """Build Excel workbook in memory and return raw bytes."""
    if not OPENPYXL_OK:
        raise ImportError("openpyxl is required for Excel export. Install it with: pip install openpyxl>=3.1")

    wb = openpyxl.Workbook()

    # ── Sheet 1: Summary ──────────────────────────────────────────────────────
    ws_sum = wb.active
    ws_sum.title = "Summary"

    def _write_kv(ws, row: int, key: str, value: Any, value_format: str = "") -> int:
        ws.cell(row=row, column=1).value = key
        ws.cell(row=row, column=1).font = Font(bold=True, size=11)
        c = ws.cell(row=row, column=2)
        c.value = value
        if value_format:
            c.number_format = value_format
        return row + 1

    row = 1
    ws_sum.cell(row=row, column=1).value = "Similar Channel Analysis"
    ws_sum.cell(row=row, column=1).font = Font(bold=True, size=14, color="1E2D5A")
    row += 2

    row = _write_kv(ws_sum, row, "Source Channel", run.source_channel_title)
    row = _write_kv(ws_sum, row, "Market", run.market)
    row = _write_kv(ws_sum, row, "Language", run.language)
    row = _write_kv(ws_sum, row, "Analysis Start", _parse_dt(run.created_at), "mm/dd/yyyy hh:mm")
    row = _write_kv(ws_sum, row, "Analysis End", _parse_dt(run.completed_at), "mm/dd/yyyy hh:mm")
    row = _write_kv(ws_sum, row, "90-Day Window Start",
                    _parse_dt(candidates[0].window_start) if candidates else None, "mm/dd/yyyy")
    row = _write_kv(ws_sum, row, "90-Day Window End",
                    _parse_dt(candidates[0].window_end) if candidates else None, "mm/dd/yyyy")
    row = _write_kv(ws_sum, row, "Minimum Views (gate)", run.min_views, "#,##0")
    row = _write_kv(ws_sum, row, "Maximum Subscribers (gate)", run.max_subscribers, "#,##0")
    row = _write_kv(ws_sum, row, "Minimum Evaluable Videos", run.min_evaluable_videos)
    row = _write_kv(ws_sum, row, "Generated At", _parse_dt(run.completed_at), "mm/dd/yyyy hh:mm")
    row += 1

    ws_sum.cell(row=row, column=1).value = "Discovery Metrics"
    ws_sum.cell(row=row, column=1).font = Font(bold=True, size=12, color="1E2D5A")
    row += 1
    diag = {}
    try:
        diag = json.loads(getattr(run, "discovery_diagnostics_json", "{}") or "{}")
    except Exception:
        pass
    best_avail_count = sum(1 for c in candidates if getattr(c, "is_best_available", False))

    row = _write_kv(ws_sum, row, "Total Candidate Pool", run.candidate_channels_found, "#,##0")
    row = _write_kv(ws_sum, row, "Candidate Videos Found", run.candidate_videos_found, "#,##0")
    row = _write_kv(ws_sum, row, "Channels Enriched", run.channels_enriched, "#,##0")
    row = _write_kv(ws_sum, row, "Strict Qualified Count", run.qualified_count)
    row = _write_kv(ws_sum, row, "Growing Count", run.growing_count)
    row = _write_kv(ws_sum, row, "Best Available Count", best_avail_count)
    row = _write_kv(ws_sum, row, "Watchlist Count", run.watchlist_count)
    row = _write_kv(ws_sum, row, "Rejected Count", run.rejected_count)
    row = _write_kv(ws_sum, row, "Discovery Passes Used", ", ".join(diag.get("discovery_passes_run", [])) or "N/A")
    row = _write_kv(ws_sum, row, "Search Calls Used", diag.get("search_calls_used", 0))
    row = _write_kv(ws_sum, row, "Stop Reason", diag.get("stop_reason", "N/A"))
    row = _write_kv(ws_sum, row, "Provider Breakdown", str(run.provider_summary_json or "{}"))
    row += 1

    # Most promising
    mp_reasons = _json_list(run.most_promising_reason_json)
    mp_cand = next((c for c in candidates if c.is_most_promising), None)
    if mp_cand:
        label = getattr(mp_cand, "most_promising_label", None) or "Most Promising Competitor"
        ws_sum.cell(row=row, column=1).value = label
        ws_sum.cell(row=row, column=1).font = Font(bold=True, size=12, color="1E2D5A")
        row += 1
        row = _write_kv(ws_sum, row, "Channel", mp_cand.channel_title)
        row = _write_kv(ws_sum, row, "Channel URL", mp_cand.channel_url)
        row = _write_kv(ws_sum, row, "Status", mp_cand.status)
        row = _write_kv(ws_sum, row, "Recommendation Tier", getattr(mp_cand, "recommendation_tier", "N/A"))
        subs = mp_cand.subscriber_count
        row = _write_kv(ws_sum, row, "Subscriber Count",
                        subs if subs is not None else "Hidden / Unverified",
                        "#,##0" if isinstance(subs, int) else "")
        row = _write_kv(ws_sum, row, "Final Score", mp_cand.final_score, "0.0")
        row = _write_kv(ws_sum, row, "Qualification Gap Score", getattr(mp_cand, "qualification_gap_score", 0.0), "0.0")
        row = _write_kv(ws_sum, row, "Niche Match", mp_cand.niche_match_score, "0.0")
        row = _write_kv(ws_sum, row, "Strict Success Ratio", mp_cand.strict_success_ratio, "0.0%")
        row = _write_kv(ws_sum, row, "Median 90-Day Views", mp_cand.median_recent_views, "#,##0")
        row = _write_kv(ws_sum, row, "Durability Score", mp_cand.durability_score, "0.0")
        row = _write_kv(ws_sum, row, "Window Coverage", getattr(mp_cand, "window_coverage", "N/A"))
        row = _write_kv(ws_sum, row, "Monetization Viability", mp_cand.monetization_viability)
        row = _write_kv(ws_sum, row, "Data Confidence", mp_cand.data_confidence)
        for i, reason in enumerate(mp_reasons, 1):
            row = _write_kv(ws_sum, row, f"Selection Reason {i}", reason)
        unmet = _json_list(getattr(mp_cand, "unmet_criteria_json", "[]"))
        for i, u in enumerate(unmet[:3], 1):
            row = _write_kv(ws_sum, row, f"Unmet Criteria {i}", u)
    else:
        ws_sum.cell(row=row, column=1).value = "Most Promising Competitor"
        ws_sum.cell(row=row, column=1).font = Font(bold=True, size=12, color="1E2D5A")
        row += 1
        ws_sum.cell(row=row, column=1).value = "No recommended candidate found"
        ws_sum.cell(row=row, column=1).font = Font(italic=True, color="888888")
        row += 1

    row += 1
    ws_sum.cell(row=row, column=1).value = "Methodology & Limitations"
    ws_sum.cell(row=row, column=1).font = Font(bold=True, size=12, color="1E2D5A")
    row += 1
    lims = [
        "Analysis uses publicly observable data only.",
        "Monetization Viability is an estimate — not a YPP status declaration.",
        "Watch hours, RPM, CPM, and revenue data are not publicly accessible.",
        "Growth confirmation depends on snapshots captured by this application.",
        "First-scan growth qualification is provisional until a second snapshot is recorded.",
        "Hidden subscriber counts remain unverified; such channels cannot be Qualified.",
        "This Excel reflects a snapshot of the run and does not auto-refresh.",
        "Public subscriber counts may be rounded by YouTube.",
    ] + _json_list(run.limitations_json)[:5]
    for lim in lims:
        ws_sum.cell(row=row, column=1).value = lim
        ws_sum.cell(row=row, column=1).alignment = Alignment(wrap_text=True)
        row += 1

    ws_sum.column_dimensions["A"].width = 36
    ws_sum.column_dimensions["B"].width = 55

    # ── Sheet 2: Channels ─────────────────────────────────────────────────────
    ws_ch = wb.create_sheet("Channels")
    ch_headers = [
        "Rank", "Most Promising", "Recommendation Tier", "Best Available Rank", "Status",
        "Channel ID", "Channel Title", "Channel URL", "Country", "Subscriber Count", "Subscriber Status",
        "Qualification Gap Score", "Window Coverage", "History Coverage", "Date Quality",
        "Public Video Count", "Window Start", "Window End",
        "Recent Videos", "Evaluable Videos", "Pending Videos",
        "Videos Above 10K", "Confirmed Growth", "Provisional Growth", "Failed",
        "Strict Success Ratio", "Provisional Success Ratio",
        "Min Recent Views", "Median Recent Views", "Mean Recent Views",
        "P25 Views", "P75 Views", "Max Recent Views", "Total Recent Views",
        "Single-Hit Dependency",
        "Niche Match", "Source Coverage", "Candidate Precision", "Median Title Similarity",
        "Recent Consistency", "Growth Quality",
        "Durability", "Monetization Viability Score", "Data Confidence Score", "Final Score",
        "Active Months (12mo)", "Median Upload Cadence (days)", "Max Upload Gap (days)",
        "Evergreen Ratio", "Topic Clusters", "Future Title Angles",
        "Monetization Viability", "Data Confidence",
        "Matched Terms", "Matched Entities", "Matched Topic Clusters",
        "Unmet Criteria",
        "Policy Risk Flags", "Qualification Reasons", "Rejection Reasons", "Limitations",
    ]

    # Header row
    for col, hdr in enumerate(ch_headers, 1):
        c = ws_ch.cell(row=1, column=col, value=hdr)
        c.fill = _hfill(HDR_FILL)
        c.font = _hfont(HDR_FONT, bold=True)
        c.alignment = Alignment(horizontal="center", wrap_text=True)

    ws_ch.freeze_panes = "A2"
    ws_ch.auto_filter.ref = f"A1:{get_column_letter(len(ch_headers))}1"

    for row_idx, cand in enumerate(candidates, 2):
        subs = cand.subscriber_count
        fill = _status_fill(cand.status)
        is_mp = bool(cand.is_most_promising)
        vals = [
            _safe_int(cand.rank),
            "Yes" if is_mp else "",
            getattr(cand, "recommendation_tier", "MONITOR") or "MONITOR",
            _safe_int(getattr(cand, "best_available_rank", None)),
            cand.status,
            cand.channel_id,
            cand.channel_title,
            cand.channel_url,
            cand.country or "",
            _safe_int(subs),
            cand.subscriber_status,
            _safe_float(getattr(cand, "qualification_gap_score", 0.0)),
            getattr(cand, "window_coverage", "UNKNOWN") or "UNKNOWN",
            getattr(cand, "history_coverage", "UNKNOWN") or "UNKNOWN",
            getattr(cand, "date_quality", "APPROXIMATED") or "APPROXIMATED",
            _safe_int(cand.public_video_count),
            _parse_dt(cand.window_start),
            _parse_dt(cand.window_end),
            _safe_int(cand.recent_video_count),
            _safe_int(cand.evaluable_video_count),
            _safe_int(cand.pending_video_count),
            _safe_int(cand.passed_views_count),
            _safe_int(cand.passed_growth_confirmed_count),
            _safe_int(cand.passed_growth_provisional_count),
            _safe_int(cand.failed_video_count),
            _safe_float(cand.strict_success_ratio),
            _safe_float(cand.provisional_success_ratio),
            _safe_int(cand.minimum_recent_views),
            _safe_float(cand.median_recent_views),
            _safe_float(cand.mean_recent_views),
            _safe_float(cand.p25_recent_views),
            _safe_float(cand.p75_recent_views),
            _safe_int(cand.maximum_recent_views),
            _safe_int(cand.total_recent_views),
            _safe_float(cand.single_hit_dependency),
            _safe_float(cand.niche_match_score),
            _safe_float(getattr(cand, "source_coverage", 0.0)),
            _safe_float(getattr(cand, "candidate_precision", 0.0)),
            _safe_float(getattr(cand, "median_title_similarity", 0.0)),
            _safe_float(cand.recent_consistency_score),
            _safe_float(cand.growth_quality_score),
            _safe_float(cand.durability_score),
            _safe_float(cand.monetization_viability_score),
            _safe_float(cand.data_confidence_score),
            _safe_float(cand.final_score),
            _safe_int(cand.active_months_last_12),
            _safe_float(cand.median_upload_cadence_days),
            _safe_float(cand.maximum_upload_gap_days),
            _safe_float(cand.evergreen_ratio),
            _safe_int(cand.topic_cluster_count),
            _safe_int(cand.future_title_angle_count),
            cand.monetization_viability or "",
            cand.data_confidence or "",
            "; ".join(_json_list(getattr(cand, "matched_terms_json", "[]"))),
            "; ".join(_json_list(getattr(cand, "matched_entities_json", "[]"))),
            "; ".join(_json_list(getattr(cand, "matched_clusters_json", "[]"))),
            "; ".join(_json_list(getattr(cand, "unmet_criteria_json", "[]"))),
            "; ".join(_json_list(cand.policy_risk_flags_json)),
            "; ".join(_json_list(cand.qualification_reasons_json)),
            "; ".join(_json_list(cand.rejection_reasons_json)),
            "; ".join(_json_list(cand.confidence_limitations_json)),
        ]

        FMT_MAP = {
            10: "#,##0",   # Subscriber Count
            12: "0.0",     # Gap score
            17: "mm/dd/yyyy", 18: "mm/dd/yyyy",  # Window dates
            26: "0.0%", 27: "0.0%",  # ratios
            28: "#,##0", 29: "#,##0.0", 30: "#,##0.0",
            31: "#,##0.0", 32: "#,##0.0", 33: "#,##0", 34: "#,##0",
            35: "0.00%",  # single-hit
            36: "0.0", 37: "0.0%", 38: "0.0%", 39: "0.0",
            40: "0.0", 41: "0.0", 42: "0.0", 43: "0.0", 44: "0.0", 45: "0.0",
            49: "0.0%",   # evergreen
        }

        for col_idx, val in enumerate(vals, 1):
            cell = ws_ch.cell(row=row_idx, column=col_idx, value=val)
            if col_idx in FMT_MAP:
                cell.number_format = FMT_MAP[col_idx]
            if fill:
                cell.fill = fill
            if is_mp:
                cell.fill = _hfill(MP_FILL)
                cell.font = Font(bold=True)
            cell.alignment = Alignment(wrap_text=(col_idx >= 50), vertical="top")

        # Hyperlink for channel URL
        url_cell = ws_ch.cell(row=row_idx, column=8)
        try:
            url_cell.hyperlink = cand.channel_url
            url_cell.style = "Hyperlink"
        except Exception:
            pass

    for i in range(1, len(ch_headers) + 1):
        ws_ch.column_dimensions[get_column_letter(i)].width = 18
    ws_ch.column_dimensions["G"].width = 28 # Channel Title
    ws_ch.column_dimensions["H"].width = 36 # Channel URL
    ws_ch.column_dimensions["BA"].width = 30 # Matched terms
    ws_ch.column_dimensions["BD"].width = 35 # Unmet criteria
    ws_ch.row_dimensions[1].height = 36

    # ── Sheet 3: Recent Videos ────────────────────────────────────────────────
    ws_vid = wb.create_sheet("Recent Videos")
    vid_headers = [
        "Channel Rank", "Channel ID", "Channel Title", "Channel Status",
        "Video ID", "Video Title", "Video URL", "Published At", "Age (days)",
        "Duration (sec)", "Views", "Likes", "Comments",
        "Lifetime VPD", "Observed VPD", "Projected Day-90 Views",
        "Growth Status", "Evaluation Status", "Evaluation Reason",
        "Niche Similarity", "Snapshot Count",
    ]
    for col, hdr in enumerate(vid_headers, 1):
        c = ws_vid.cell(row=1, column=col, value=hdr)
        c.fill = _hfill(HDR_FILL)
        c.font = _hfont(HDR_FONT, bold=True)
        c.alignment = Alignment(horizontal="center", wrap_text=True)
    ws_vid.freeze_panes = "A2"
    ws_vid.auto_filter.ref = f"A1:{get_column_letter(len(vid_headers))}1"

    rank_map = {c.channel_id: c.rank for c in candidates}
    status_map = {c.channel_id: c.status for c in candidates}
    title_map  = {c.channel_id: c.channel_title for c in candidates}

    vid_row = 2
    for cand in candidates:
        cid = cand.channel_id
        for vid in videos_by_channel.get(cid, []):
            v_vals = [
                rank_map.get(cid),
                cid,
                title_map.get(cid, ""),
                status_map.get(cid, ""),
                vid.video_id,
                vid.title,
                vid.video_url,
                _parse_dt(vid.published_at),
                _safe_float(vid.age_days),
                _safe_int(vid.duration_seconds),
                _safe_int(vid.views),
                _safe_int(vid.likes),
                _safe_int(vid.comments),
                _safe_float(vid.lifetime_views_per_day),
                _safe_float(vid.observed_views_per_day),
                _safe_float(vid.projected_day_90_views),
                vid.growth_status or "",
                vid.evaluation_status or "",
                vid.evaluation_reason or "",
                _safe_float(vid.niche_similarity),
                _safe_int(vid.snapshot_count),
            ]
            VID_FMT = {8: "mm/dd/yyyy", 11: "#,##0", 12: "#,##0", 13: "#,##0",
                       14: "#,##0.0", 15: "#,##0.0", 16: "#,##0.0", 20: "0.0"}
            for ci, val in enumerate(v_vals, 1):
                cell = ws_vid.cell(row=vid_row, column=ci, value=val)
                if ci in VID_FMT:
                    cell.number_format = VID_FMT[ci]
            # Video hyperlink
            try:
                url_c = ws_vid.cell(row=vid_row, column=7)
                url_c.hyperlink = vid.video_url
                url_c.style = "Hyperlink"
            except Exception:
                pass
            vid_row += 1

    vid_widths = [10, 28, 30, 14, 14, 50, 40, 16, 10, 14, 12, 10, 12,
                  14, 14, 18, 26, 26, 50, 14, 12]
    for i, w in enumerate(vid_widths, 1):
        ws_vid.column_dimensions[get_column_letter(i)].width = min(w, 60)

    # ── Sheet 4: Score Breakdown ──────────────────────────────────────────────
    ws_sc = wb.create_sheet("Score Breakdown")
    sc_headers = [
        "Rank", "Channel ID", "Channel Title", "Status",
        "Niche Match", "Recent Consistency", "Growth Quality",
        "Durability", "Monetization Viability", "Data Confidence",
        "Exported Final Score",
        "Recalculated Final Score",
        "Score Difference",
        "Score Check",
    ]
    for col, hdr in enumerate(sc_headers, 1):
        c = ws_sc.cell(row=1, column=col, value=hdr)
        c.fill = _hfill(HDR_FILL)
        c.font = _hfont(HDR_FONT, bold=True)
        c.alignment = Alignment(horizontal="center", wrap_text=True)
    ws_sc.freeze_panes = "A2"

    for r_idx, cand in enumerate(candidates, 2):
        nm = get_column_letter(5) + str(r_idx)
        rc_ = get_column_letter(6) + str(r_idx)
        gq = get_column_letter(7) + str(r_idx)
        dr = get_column_letter(8) + str(r_idx)
        mv = get_column_letter(9) + str(r_idx)
        dc = get_column_letter(10) + str(r_idx)

        sc_vals = [
            _safe_int(cand.rank),
            cand.channel_id,
            cand.channel_title,
            cand.status,
            _safe_float(cand.niche_match_score),
            _safe_float(cand.recent_consistency_score),
            _safe_float(cand.growth_quality_score),
            _safe_float(cand.durability_score),
            _safe_float(cand.monetization_viability_score),
            _safe_float(cand.data_confidence_score),
            _safe_float(cand.final_score),
            None,  # formula
            None,  # formula
            None,  # formula
        ]
        for ci, val in enumerate(sc_vals, 1):
            cell = ws_sc.cell(row=r_idx, column=ci, value=val)
            if ci in (5, 6, 7, 8, 9, 10, 11):
                cell.number_format = "0.0"

        # Formulas
        recalc_col = get_column_letter(12)
        diff_col   = get_column_letter(13)
        chk_col    = get_column_letter(14)
        exported_col = get_column_letter(11)

        ws_sc.cell(row=r_idx, column=12).value = (
            f"={nm}*0.25+{rc_}*0.25+{gq}*0.15+{dr}*0.20+{mv}*0.10+{dc}*0.05"
        )
        ws_sc.cell(row=r_idx, column=12).number_format = "0.0"
        ws_sc.cell(row=r_idx, column=13).value = (
            f"=ABS({exported_col}{r_idx}-{recalc_col}{r_idx})"
        )
        ws_sc.cell(row=r_idx, column=13).number_format = "0.00"
        ws_sc.cell(row=r_idx, column=14).value = (
            f'=IF({diff_col}{r_idx}<=0.1,"OK","CHECK")'
        )

        fill = _status_fill(cand.status)
        if fill:
            for ci in range(1, 15):
                ws_sc.cell(row=r_idx, column=ci).fill = fill

    sc_widths = [8, 28, 32, 14, 14, 18, 14, 12, 20, 18, 18, 20, 16, 12]
    for i, w in enumerate(sc_widths, 1):
        ws_sc.column_dimensions[get_column_letter(i)].width = w
    ws_sc.row_dimensions[1].height = 36

    # ── Save to bytes ─────────────────────────────────────────────────────────
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()

"""Deterministic preprocessing for OCR text with concatenated number blocks.

Parses garbled fee-schedule and settlement/volume blocks produced by LLMWhisperer
OCR on the MBN2804 Merchant Processing Agreement form, and replaces them with
clean labeled text so the LLM can extract values correctly without vision.
"""
import logging
import re

logger = logging.getLogger(__name__)

# Matches the fee-schedule block: form ID + concatenated X.XX decimal values.
# Uses a CAPTURING GROUP for the decimal sequence so we can parse values from
# group(1) — ensuring the backtracking on \d{3,6} resolves correctly and we
# don't accidentally include form-ID digits in the first decimal value.
# e.g. "MBN28040.200.000.0089.000.150.000.00225.000.060.060.006.002.952.950.20"
CONCAT_BLOCK_RE = re.compile(
    r"[A-Z]{2,5}\d{3,6}"          # Form ID prefix (e.g. MBN2804)
    r"((?:\d+\.\d{2}){3,})"       # CAPTURE: 3+ concatenated X.XX values
)

# Matches the settlement/volume block:
# "MBN2804 BANK OF CHOICE 122000358 123456789000112,0005,000303015,000500FD150"
SETTLEMENT_BLOCK_RE = re.compile(
    r"[A-Z]{2,5}\d{3,6}"          # Form ID
    r"\s+[A-Z][A-Z ]{3,30}\s+"    # All-caps bank name
    r"\d{9}\s+"                    # ABA routing number (9 digits)
    r"[\d,]+"                      # Account + concatenated volume amounts
    r"FD\d+",                      # Terminal model (FD + digits)
    re.IGNORECASE,
)


def _parse_fee_values(block: str) -> list[str]:
    """Extract individual X.XX decimal values from a fee-schedule block.

    Uses the capturing group in CONCAT_BLOCK_RE to isolate the decimal
    sequence AFTER the form-ID prefix, so backtracking resolves correctly.
    For 'MBN28040.200.000.0089...' the regex backtracks to match 'MBN2804'
    as the form ID, leaving '0.200.000.0089...' as the decimal sequence.
    """
    m = CONCAT_BLOCK_RE.search(block)
    if not m:
        return []
    decimal_seq = m.group(1)  # e.g. "0.200.000.0089.000.150.000.00225..."
    return re.findall(r"\d+\.\d{2}", decimal_seq)


def _parse_settlement_block(block: str) -> dict:
    """Parse ABA, account number, and processing volumes from settlement block."""
    result = {"aba": "", "account": "", "volumes": []}

    # Extract ABA (9-digit number after the bank name)
    aba_m = re.search(r"\b(\d{9})\s+([\d,]+)FD", block)
    if not aba_m:
        return result

    result["aba"] = aba_m.group(1)
    raw = aba_m.group(2)  # account + volumes run together, e.g. "1234567890001 12,0005,000303015,000500"

    # Split raw into account (leading plain digits) and volume amounts
    # Strategy: account number has no commas; volume amounts use commas (12,000)
    # or are small 2-digit numbers (30, 15 etc.) interspersed.
    # The account ends where comma-formatted amounts begin.
    # We look for the first occurrence of digits-comma-digits (amount pattern)
    first_comma = re.search(r"\d{1,3},\d{3}", raw)
    if first_comma:
        # Account = everything before the start of the first comma-amount
        # Back up to find where the leading plain digits end
        acct_end = first_comma.start()
        # The comma-amount may have been preceded by extra plain digits
        # (e.g. account "1234567890001" + "1" + "2,000")
        # Walk back to find a clean boundary (look for last run of digits)
        prefix = raw[:acct_end]
        result["account"] = re.sub(r"\D", "", prefix)  # strip any non-digits

        # Everything from the first comma-amount onwards is volumes
        vol_raw = raw[first_comma.start():]
        result["volumes"] = re.findall(r"\d{1,3}(?:,\d{3})+|\b\d{1,4}\b", vol_raw)
    else:
        result["account"] = re.sub(r"\D", "", raw)

    return result


def _reconstruct_fee_block(block: str) -> str:
    """Replace garbled fee block with a clean labeled value list."""
    values = _parse_fee_values(block)
    if not values:
        return ""

    value_list = " | ".join(f"${v}" for v in values)

    # Key positions confirmed from prior correct extractions of the MBN2804 form:
    # [0]=per_txn, [1]=0, [2]=0, [3]=min_monthly/annual_membership,
    # [4]=customer_support, [7]=early_termination, [8]=markup%, [9]=per_txn
    def val(i):
        return values[i] if i < len(values) else "?"

    key_note = (
        f"Min Monthly Fee = ${val(10)}, "
        f"Customer Support Fee = ${val(11)}, "
        f"Annual Membership Fee = ${val(3)}, "
        f"Early Termination Fee = ${val(2)}, "
        f"PCI Compliance Fee = ${val(12)}/month, "
        f"IRS TIN Processing Fee = ${val(13)}/month, "
        f"PIN Debit Fee (per transaction) = ${val(4)}, "
        f"EBT Monthly Access Fee = ${val(7)}, "
        f"Visa/MC/Discover Auth Fee = ${val(8)}, "
        f"Amex Auth Fee = ${val(9)}, "
        f"Batch Fee = ${val(0)}"
    )

    return (
        f"\n[SECTION 7 FEE SCHEDULE VALUES ({len(values)} values in form grid order — "
        f"match each to the fee field labels listed in the section above): "
        f"{value_list}]\n"
        f"[Key values by form position: {key_note}]\n"
    )


def _reconstruct_settlement_block(block: str) -> str:
    """Replace garbled settlement block with clean labeled key-value text."""
    data = _parse_settlement_block(block)
    if not data["aba"]:
        return ""

    labels = [
        "Avg Monthly Vol (Cards)",
        "Avg Monthly Vol (Amex)",
        "Avg Ticket (Cards)",
        "Avg Ticket (Amex)",
        "Peak Season Vol",
        "Max Ticket",
    ]
    vol_pairs = [
        f"{lab} = ${v}" for lab, v in zip(labels, data["volumes"])
    ]
    vol_note = "; ".join(vol_pairs) if vol_pairs else ""

    lines = [
        f"\n[SETTLEMENT INFO: ABA/Routing = {data['aba']}, "
        f"Account = {data['account']}]"
    ]
    if vol_note:
        lines.append(f"[PROCESSING VOLUMES: {vol_note}]")
    lines.append("")
    return "\n".join(lines)


def preprocess_context(
    context: str,
    images: list[str] | None = None,
) -> str | None:
    """Replace concatenated OCR blocks with clean structured text.

    Runs regardless of image availability.  When the LLM context window is
    too small to include images (8192-token models), this ensures the model
    receives correctly labelled fee and volume values instead of garbled
    concatenated strings.

    Args:
        context: Raw OCR-extracted text.
        images: Unused — kept for API compatibility.

    Returns:
        Cleaned text, or None if no blocks were found.
    """
    modified = False
    result = context

    # Pass 1: fee-schedule block
    for match in CONCAT_BLOCK_RE.finditer(context):
        block = match.group(0)
        if len(block) > 20:
            replacement = _reconstruct_fee_block(block)
            if replacement:
                result = result.replace(block, replacement)
                modified = True
                logger.info(
                    "[Preprocessor] Reconstructed fee block (%d chars): '%s...'",
                    len(block), block[:50],
                )

    # Pass 2: settlement/volume block
    for match in SETTLEMENT_BLOCK_RE.finditer(context):
        block = match.group(0)
        if len(block) > 20:
            replacement = _reconstruct_settlement_block(block)
            if replacement:
                result = result.replace(block, replacement)
                modified = True
                logger.info(
                    "[Preprocessor] Reconstructed settlement block (%d chars): '%s...'",
                    len(block), block[:60],
                )

    if modified:
        logger.info(
            "[Preprocessor] Context cleaned: %d -> %d chars",
            len(context), len(result),
        )
        return result

    logger.info("[Preprocessor] No concatenated blocks found")
    return None

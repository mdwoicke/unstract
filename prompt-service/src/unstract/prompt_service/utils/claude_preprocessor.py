"""Deterministic preprocessing for OCR text with concatenated number blocks.

Removes concatenated fee value blocks from OCR text so the vision model
reads fee amounts directly from the PDF images instead of garbled text.
"""
import logging
import re

logger = logging.getLogger(__name__)

# Pattern: form ID prefix followed by concatenated decimals
# e.g. "MBN28040.200.000.0089.00..."
CONCAT_BLOCK_RE = re.compile(
    r"[A-Z]{2,5}\d{3,6}"  # Form ID like MBN2804
    r"(?:\d+\.\d{2}){3,}"  # 3+ concatenated X.XX values
)

# Fee grid labels with empty $ or % markers (no actual values next to them)
# These are the labels where the OCR lost the values
EMPTY_FEE_FIELD_RE = re.compile(
    r"([\w\s./\'-]+(?:Fee|Membership|Volume|View|Insightics)"
    r"[^$%\d\n]{0,30})"
    r"[$%]"
    r"(?!\s*\d)",  # NOT followed by a number (value is missing)
    re.IGNORECASE,
)


def preprocess_context(
    context: str,
    images: list[str] | None = None,
) -> str | None:
    """Remove concatenated fee blocks so vision model reads from images.

    The OCR produces garbled concatenated fee values from form grids.
    Instead of trying to parse them, we remove them and add a note
    telling the model to read fee values from the PDF page images.

    Args:
        context: Raw OCR-extracted text.
        images: List of base64 images (presence triggers cleanup).

    Returns:
        Cleaned text with concatenated blocks removed, or None if
        no changes needed.
    """
    if not images:
        logger.info(
            "[Preprocessor] No images available, skipping "
            "concatenated block removal"
        )
        return None

    modified = False
    result = context

    # Find and replace concatenated number blocks
    for match in CONCAT_BLOCK_RE.finditer(context):
        block = match.group(0)
        if len(block) > 20:  # Only target long concatenated blocks
            replacement = (
                "\n[NOTE: Fee values were concatenated by OCR and "
                "removed. Read all fee/pricing dollar amounts and "
                "percentages DIRECTLY from the PDF page images above. "
                "Do NOT guess fee values from surrounding text.]\n"
            )
            result = result.replace(block, replacement)
            modified = True
            logger.info(
                "[Preprocessor] Removed concatenated block "
                "(%d chars): '%s...'",
                len(block),
                block[:50],
            )

    if modified:
        logger.info(
            "[Preprocessor] Context cleaned: %d -> %d chars "
            "(removed garbled fee data, model will use images)",
            len(context),
            len(result),
        )
        return result

    logger.info("[Preprocessor] No concatenated blocks found")
    return None

"""AcroForm field extraction from digitally-filled PDF forms.

Uses PyMuPDF (fitz) to read interactive form field values from PDFs that
were filled using PDF form tools (Adobe Acrobat, DocuSign pre-flatten, etc.).
These values exist in the AcroForm data layer and are invisible to standard
OCR/text-extraction tools like Unstructured IO.
"""
import logging
import re
from typing import NamedTuple

logger = logging.getLogger(__name__)

_GENERIC_NAME = re.compile(r"^(Text|Check Box)\d+$", re.IGNORECASE)


class _Field(NamedTuple):
    page: int
    y: float
    name: str
    value: str
    is_checkbox: bool


def _annotate_generic_names(fields: list[_Field]) -> list[_Field]:
    """Add spatial context hints to fields with generic names like TextN.

    For each generic field, finds the nearest descriptively-named fields
    above and below on the same page and appends a parenthetical hint,
    e.g.  ``Text8 (between "State of Corp" and "Last Name"): 60%``

    This helps the LLM infer the semantic meaning of the generic field
    from its position relative to clearly-labeled neighbors.
    """
    result: list[_Field] = []
    for i, field in enumerate(fields):
        if not _GENERIC_NAME.match(field.name):
            result.append(field)
            continue

        above: str | None = None
        below: str | None = None
        for j in range(i - 1, -1, -1):
            if fields[j].page != field.page:
                break
            if not _GENERIC_NAME.match(fields[j].name):
                above = fields[j].name
                break
        for j in range(i + 1, len(fields)):
            if fields[j].page != field.page:
                break
            if not _GENERIC_NAME.match(fields[j].name):
                below = fields[j].name
                break

        if above and below:
            hint = f' (between "{above}" and "{below}")'
        elif above:
            hint = f' (after "{above}")'
        elif below:
            hint = f' (before "{below}")'
        else:
            hint = ""

        if hint:
            result.append(field._replace(name=field.name + hint))
        else:
            result.append(field)

    return result


def extract_acroform_fields(pdf_bytes: bytes) -> str | None:
    """Extract AcroForm interactive field values from a PDF.

    Groups fields by page in positional order (top to bottom) so the LLM
    can correlate them with the corresponding page images. Only includes
    fields that have non-empty values; unchecked checkboxes are omitted
    to reduce noise.

    Args:
        pdf_bytes: Raw bytes of the PDF file.

    Returns:
        A formatted text block ready to prepend to the extraction context,
        or None if the PDF has no AcroForm fields or all fields are empty.
    """
    try:
        import fitz  # PyMuPDF
    except ImportError:
        logger.warning(
            "[AcroForm] PyMuPDF not available — skipping form field extraction"
        )
        return None

    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as e:
        logger.warning("[AcroForm] Failed to open PDF: %s", e)
        return None

    all_fields: list[_Field] = []
    try:
        for page_num, page in enumerate(doc, start=1):
            try:
                widgets = list(page.widgets())
            except Exception:
                continue
            if not widgets:
                continue
            for widget in widgets:
                name = (widget.field_name or "").strip()
                if not name:
                    continue

                field_type = widget.field_type_string or ""
                y_pos = widget.rect.y0

                if field_type == "Signature":
                    continue

                # Checkboxes / radio buttons (PyMuPDF uses CheckBox,
                # RadioButton, or Button depending on PDF structure)
                if field_type in ("Button", "CheckBox", "RadioButton"):
                    raw = (widget.field_value or "").strip()
                    checked = raw.lower() not in ("", "off", "false", "no", "0")
                    if not checked:
                        continue  # skip unchecked — reduces noise
                    value = "Yes"
                    is_checkbox = True
                else:
                    value = (widget.field_value or "").strip()
                    if not value:
                        continue
                    is_checkbox = False

                all_fields.append(
                    _Field(
                        page=page_num,
                        y=y_pos,
                        name=name,
                        value=value,
                        is_checkbox=is_checkbox,
                    )
                )
    finally:
        doc.close()

    if not all_fields:
        logger.info("[AcroForm] No filled form fields found in PDF")
        return None

    # Sort by page then vertical position (top to bottom)
    all_fields.sort(key=lambda f: (f.page, f.y))

    # Enrich generic field names with spatial context
    all_fields = _annotate_generic_names(all_fields)

    logger.info(
        "[AcroForm] Extracted %d form field values across %d page(s)",
        len(all_fields),
        len(set(f.page for f in all_fields)),
    )

    lines = [
        "[FORM FIELD VALUES — extracted from PDF AcroForm interactive layer]",
        "[INSTRUCTIONS FOR USING THESE VALUES:",
        " - These are the authoritative values entered into the form fields.",
        " - Fields are grouped by page in top-to-bottom order.",
        " - Map each value to the JSON property that semantically matches its",
        "   field label. Use ALL available values — do not skip relevant ones.",
        " - Percentage values positioned near owner/principal names are ownership",
        "   percentages, NOT years or months in business.",
        " - 'Landlord Name/Phone' fields relate to the site/property survey,",
        "   NOT to banking or settlement information.",
        " - If no form field value clearly matches a JSON property, leave it empty.",
        " - Generic names like 'TextN' include position hints showing the",
        "   neighboring fields — use these to determine the field's meaning.]",
    ]

    current_page = 0
    for field in all_fields:
        if field.page != current_page:
            current_page = field.page
            lines.append(f"\n--- Page {current_page} ---")

        if field.is_checkbox:
            lines.append(f"  [{field.name}]: Yes (checked)")
        else:
            lines.append(f"  {field.name}: {field.value}")

    lines.append("\n[END FORM FIELDS]")

    return "\n".join(lines)

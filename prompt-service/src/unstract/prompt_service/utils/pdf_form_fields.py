"""AcroForm field extraction from digitally-filled PDF forms.

Uses PyMuPDF (fitz) to read interactive form field values from PDFs that
were filled using PDF form tools (Adobe Acrobat, DocuSign pre-flatten, etc.).
These values exist in the AcroForm data layer and are invisible to standard
OCR/text-extraction tools like Unstructured IO.
"""
import logging

logger = logging.getLogger(__name__)


# Field types to skip — buttons and signature fields carry no text value
_SKIP_FIELD_TYPES = {
    "Button",    # checkboxes and radio buttons (we handle these separately)
    "Signature", # signature image fields
}


def extract_acroform_fields(pdf_bytes: bytes) -> str | None:
    """Extract AcroForm interactive field values from a PDF.

    Reads every widget annotation on every page and collects field names
    paired with their current values.  Checkbox/radio values are normalised
    to True/False so the LLM can reason about them.

    Args:
        pdf_bytes: Raw bytes of the PDF file.

    Returns:
        A formatted text block ready to prepend to the extraction context,
        or None if the PDF has no AcroForm fields or all fields are empty.
    """
    try:
        import fitz  # PyMuPDF
    except ImportError:
        logger.warning("[AcroForm] PyMuPDF not available — skipping form field extraction")
        return None

    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as e:
        logger.warning("[AcroForm] Failed to open PDF: %s", e)
        return None

    fields: dict[str, str] = {}
    try:
        for page_num, page in enumerate(doc, start=1):
            try:
                widgets = page.widgets()
            except Exception:
                continue
            if not widgets:
                continue
            for widget in widgets:
                name = (widget.field_name or "").strip()
                if not name:
                    continue

                field_type = widget.field_type_string or ""

                # Checkboxes and radio buttons: normalise to Yes/No
                if field_type == "Button":
                    raw = widget.field_value or ""
                    # AcroForm uses "Yes"/"Off" or similar strings for checkboxes
                    checked = raw.strip().lower() not in ("", "off", "false", "no", "0")
                    value = "Yes" if checked else "No"
                elif field_type == "Signature":
                    continue
                else:
                    value = (widget.field_value or "").strip()

                if not value or value.lower() in ("", "off"):
                    continue

                # De-duplicate: last write on the page wins (handles repeated
                # field names across pages, e.g. headers)
                fields[name] = value
    finally:
        doc.close()

    if not fields:
        logger.info("[AcroForm] No filled form fields found in PDF")
        return None

    logger.info("[AcroForm] Extracted %d form field values from PDF", len(fields))

    lines = ["[FORM FIELD VALUES — extracted directly from PDF AcroForm layer]"]
    for name, value in fields.items():
        lines.append(f"{name}: {value}")
    lines.append("[END FORM FIELDS]")

    return "\n".join(lines)

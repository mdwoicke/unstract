"""Utility for converting PDF pages to base64 images for vision models."""

import base64
import logging
from io import BytesIO

logger = logging.getLogger(__name__)


def pdf_pages_to_base64(
    pdf_path: str,
    pages: list[int] | None = None,
    dpi: int = 150,
    max_pages: int = 5,
) -> list[str]:
    """Convert PDF pages to base64-encoded PNG images.

    Args:
        pdf_path: Path to the PDF file.
        pages: Specific page numbers (0-indexed) to convert.
            If None, converts up to max_pages from the start.
        dpi: Resolution for rendering. 150 gives good quality
            without excessive size.
        max_pages: Maximum number of pages to convert.

    Returns:
        List of base64-encoded PNG image strings.
    """
    try:
        import fitz  # pymupdf
    except ImportError:
        logger.warning("pymupdf not installed — vision extraction disabled")
        return []

    images: list[str] = []
    try:
        doc = fitz.open(pdf_path)
        total_pages = len(doc)

        if pages is None:
            pages = list(range(min(total_pages, max_pages)))
        else:
            pages = [p for p in pages if 0 <= p < total_pages][:max_pages]

        zoom = dpi / 72.0
        matrix = fitz.Matrix(zoom, zoom)

        for page_num in pages:
            page = doc[page_num]
            pix = page.get_pixmap(matrix=matrix)
            img_bytes = pix.tobytes("png")
            b64 = base64.b64encode(img_bytes).decode("utf-8")
            images.append(b64)

        doc.close()
        logger.info(
            "Rendered %d PDF pages to images (dpi=%d)", len(images), dpi
        )
    except Exception as e:
        logger.error("Failed to render PDF pages: %s", e)

    return images

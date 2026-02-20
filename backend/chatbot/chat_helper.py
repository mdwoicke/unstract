import base64
import json
import logging
import re
import uuid

import litellm
from adapter_processor_v2.models import AdapterInstance
from api_v2.models import APIKey
from django.core.files.uploadedfile import InMemoryUploadedFile
from rest_framework.exceptions import ValidationError
from utils.constants import Account
from utils.local_context import StateStore
from utils.user_context import UserContext

from api_v2.deployment_helper import DeploymentHelper
from chatbot.constants import MAX_CONVERSATION_HISTORY, SYSTEM_PROMPT
from chatbot.chat_skills import apply_skills

logger = logging.getLogger(__name__)


def _pdf_bytes_to_base64_images(pdf_bytes, max_pages=5, dpi=150):
    """Convert PDF bytes to base64-encoded JPEG images for vision models.

    Uses JPEG at 85% quality instead of PNG — typically 5-10x smaller,
    which avoids "failed to process image" errors from endpoints with
    payload size limits.

    Args:
        pdf_bytes: Raw bytes of the PDF file.
        max_pages: Maximum number of pages to render.
        dpi: Resolution for rendering (lower = smaller payload).

    Returns:
        list[str]: Base64-encoded JPEG images.
    """
    try:
        import fitz  # pymupdf
    except ImportError:
        logger.warning("pymupdf not installed — vision support disabled")
        return []

    images = []
    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        zoom = dpi / 72.0
        matrix = fitz.Matrix(zoom, zoom)
        for i in range(min(len(doc), max_pages)):
            pix = doc[i].get_pixmap(matrix=matrix)
            # Convert to RGB if necessary (JPEG doesn't support alpha channel)
            if pix.alpha:
                pix = fitz.Pixmap(fitz.csRGB, pix)
            img_bytes = pix.tobytes("jpeg", jpg_quality=85)
            images.append(base64.b64encode(img_bytes).decode("utf-8"))
        doc.close()
        logger.info("Rendered %d PDF pages for vision model", len(images))
    except Exception as e:
        logger.error("Failed to render PDF pages: %s", e)
    return images


def extract_document(api_deployment_id, file_obj):
    """Extract document content using an existing API deployment.

    Args:
        api_deployment_id: UUID of the API deployment to use
        file_obj: UploadedFile object to process

    Returns:
        str: Extracted document content as a string
    """
    from api_v2.models import APIDeployment

    try:
        api_deployment = APIDeployment.objects.get(id=api_deployment_id)
    except APIDeployment.DoesNotExist:
        raise ValidationError("API deployment not found.")

    if not api_deployment.is_active:
        raise ValidationError("API deployment is not active.")

    organization_id = UserContext.get_organization_identifier()

    result = DeploymentHelper.execute_workflow(
        organization_name=organization_id,
        api=api_deployment,
        file_objs=[file_obj],
        timeout=300,
        include_metadata=False,
        include_metrics=False,
        use_file_history=False,
    )

    # Extract the result text from the execution response
    status = result.get("execution_status", "")
    if status == "ERROR":
        error_msg = result.get("error", "Unknown error during extraction")
        raise ValidationError(f"Document extraction failed: {error_msg}")

    # The result field contains the extracted data
    result_data = result.get("result", [])
    if result_data:
        # result is typically a list of dicts with 'result' key
        extracted_parts = []
        for item in result_data:
            if isinstance(item, dict):
                output = item.get("result", item.get("output", ""))
                if isinstance(output, dict):
                    output = json.dumps(output, indent=2)
                extracted_parts.append(str(output))
            else:
                extracted_parts.append(str(item))
        return "\n\n".join(extracted_parts)

    return str(result_data)


def _find_llm_adapter_from_workflow(workflow):
    """Find the LLM adapter configured in a workflow's tool instances.

    Traces: ToolInstance -> prompt_registry_id -> PromptStudioRegistry
    -> CustomTool -> ProfileManager (default) -> llm AdapterInstance.

    This ensures the chat uses the exact same LLM model configured
    for data extraction in Prompt Studio.

    Args:
        workflow: The Workflow instance to inspect

    Returns:
        AdapterInstance or None: The LLM adapter if found
    """
    from prompt_studio.prompt_profile_manager_v2.models import ProfileManager
    from prompt_studio.prompt_studio_registry_v2.models import (
        PromptStudioRegistry,
    )
    from tool_instance_v2.models import ToolInstance

    tool_instances = ToolInstance.objects.filter(
        workflow=workflow,
    ).order_by("step")

    for tool_instance in tool_instances:
        metadata = tool_instance.metadata or {}
        registry_id = metadata.get("prompt_registry_id")
        if not registry_id:
            continue

        try:
            registry = PromptStudioRegistry.objects.get(
                prompt_registry_id=registry_id,
            )
        except PromptStudioRegistry.DoesNotExist:
            logger.warning(
                "PromptStudioRegistry '%s' not found", registry_id
            )
            continue

        custom_tool = registry.custom_tool
        if not custom_tool:
            continue

        try:
            default_profile = ProfileManager.get_default_llm_profile(
                custom_tool
            )
            adapter = default_profile.llm
            logger.info(
                "Resolved LLM adapter '%s' from workflow's "
                "Prompt Studio default profile",
                adapter.adapter_name,
            )
            return adapter
        except Exception:
            logger.warning(
                "Could not get default LLM profile for tool '%s'",
                custom_tool.tool_name,
            )
            continue

    return None


def _resolve_llm_adapter_from_api_key(api_key_str):
    """Resolve an LLM adapter from an API key.

    First tries to find the LLM adapter configured in the workflow's
    tool instance (same model used for extraction). Falls back to the
    first LLM adapter in the organization.

    Looks up: APIKey -> APIDeployment -> Workflow -> ToolInstance -> LLM

    Args:
        api_key_str: The API key string (UUID)

    Returns:
        AdapterInstance: The LLM adapter instance

    Raises:
        ValidationError: If no LLM adapter is found
    """
    try:
        api_key_instance = APIKey.objects.get(api_key=api_key_str)
    except (APIKey.DoesNotExist, Exception):
        raise ValidationError("Invalid API key.")

    if not api_key_instance.is_active:
        raise ValidationError("API key is not active.")

    # Get organization from the API deployment
    api_deployment = api_key_instance.api
    if not api_deployment:
        raise ValidationError("API key is not associated with a deployment.")

    organization = api_deployment.organization

    # Set organization context so the default manager filter works
    StateStore.set(Account.ORGANIZATION_ID, organization.organization_id)

    # Use a general-purpose LLM adapter from the organization.
    # We intentionally skip the workflow's Prompt Studio adapter because
    # it may be a specialised model (e.g. OCR) unsuitable for chat.
    # Prefer "Qwen-3L" adapter (qwen3-vl-8b) for fast local inference.
    adapter = AdapterInstance.objects.filter(
        adapter_type="LLM",
        adapter_name="Qwen-3L",
    ).first()
    if not adapter:
        adapter = AdapterInstance.objects.filter(
            adapter_type="LLM",
        ).exclude(
            adapter_name__icontains="ocr",
        ).exclude(
            adapter_name__icontains="docling",
        ).first()

    if not adapter:
        raise ValidationError(
            "No LLM adapter configured for this organization. "
            "Please add an LLM adapter in Unstract settings."
        )

    return adapter


def _is_vision_error(exc: Exception) -> bool:
    """Return True if the exception was caused by unsupported vision/image input.

    Checks the HTTP status code first (more reliable than message strings)
    and then falls back to keyword matching across the full error text.
    Covers OpenAI-compatible, Anthropic, and Ollama error shapes.
    """
    status_code = getattr(exc, "status_code", None) or getattr(
        exc, "http_status", None
    )
    if status_code not in (400, 422):
        return False
    msg = str(exc).lower()
    vision_keywords = (
        "image",
        "vision",
        "multimodal",
        "failed to process",
        "unsupported content",
        "does not support",
        "invalid content",
    )
    return any(kw in msg for kw in vision_keywords)


def _strip_images_from_messages(messages: list) -> list:
    """Return a copy of messages with all image_url parts removed."""
    text_only = []
    for m in messages:
        content = m.get("content")
        if isinstance(content, list):
            text_parts = [
                p["text"] for p in content if p.get("type") == "text"
            ]
            text_only.append(
                {"role": m["role"], "content": " ".join(text_parts)}
            )
        else:
            text_only.append(m)
    return text_only


def _call_llm(
    adapter_instance,
    message,
    document_context,
    conversation_history,
    raw_document_text="",
    pdf_images=None,
):
    """Call LLM using an adapter instance.

    Args:
        adapter_instance: AdapterInstance with adapter_type="LLM"
        message: The user's chat message
        document_context: Extracted document content
        conversation_history: List of previous messages [{role, content}]
        raw_document_text: Raw OCR text from LLMWhisperer (optional)
        pdf_images: List of base64-encoded PDF page images (optional).
            When provided, these are sent to vision-capable models so
            the LLM can see the actual document layout.

    Returns:
        str: The LLM's response text
    """
    adapter_metadata = adapter_instance.metadata
    adapter_id = adapter_instance.adapter_id

    from unstract.sdk1.adapters.constants import Common
    from unstract.sdk1.adapters.llm1 import adapters

    adapter_class = adapters[adapter_id][Common.MODULE]
    completion_kwargs = adapter_class.validate(adapter_metadata)

    system_content = f"{SYSTEM_PROMPT}\n\n"
    if pdf_images:
        system_content += (
            "You have been provided with images of the original document "
            "pages. Use these images as the PRIMARY source of truth when "
            "answering questions. Cross-reference the extracted data and "
            "OCR text against what you can see in the images.\n"
            "You may cite text that you can read directly from the document "
            "images using the same citation format.\n\n"
        )
    system_content += (
        f"--- EXTRACTED DATA (structured — do NOT cite from this) ---\n"
        f"{document_context}\n"
    )
    if raw_document_text:
        system_content += (
            f"--- ORIGINAL DOCUMENT TEXT (source of truth — cite ONLY "
            f"from this) ---\n{raw_document_text}\n"
        )
    else:
        if not pdf_images:
            logger.warning(
                "No raw_document_text provided — citations will be disabled. "
                "Ensure include_metadata=true and extracted_text is available."
            )
    system_content += "--- END ---"

    messages = [{"role": "system", "content": system_content}]

    # Add conversation history (truncated to max)
    history = conversation_history[-MAX_CONVERSATION_HISTORY:]
    for msg in history:
        role = msg.get("role", "user")
        content = msg.get("content", "")
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": content})

    # Build user message with optional vision content
    if pdf_images:
        user_content = [{"type": "text", "text": message}]
        for img_b64 in pdf_images:
            user_content.append(
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/jpeg;base64,{img_b64}"},
                }
            )
        messages.append({"role": "user", "content": user_content})
    else:
        messages.append({"role": "user", "content": message})

    litellm.drop_params = True

    # Track whether we actually sent images so citation-strip logic is correct
    sent_images = bool(pdf_images)
    try:
        response = litellm.completion(messages=messages, **completion_kwargs)
    except (
        litellm.BadRequestError,
        litellm.UnsupportedParamsError,
        litellm.APIError,
    ) as e:
        if sent_images and _is_vision_error(e):
            logger.warning(
                "Model rejected vision input (status=%s) — retrying text-only: %s",
                getattr(e, "status_code", "?"),
                e,
            )
            response = litellm.completion(
                messages=_strip_images_from_messages(messages),
                **completion_kwargs,
            )
            sent_images = False  # images were dropped for citation-strip logic
        else:
            raise

    response_text = response["choices"][0]["message"]["content"]

    # Strip citations when no raw document text AND no vision images were sent,
    # since the LLM may hallucinate citation markers from extracted data.
    if not raw_document_text and not sent_images:
        response_text = re.sub(r'\s*\[cite:\s*"[^"]*"\]', "", response_text)

    # Skill layer: deterministic post-processing (e.g. JSON → prose)
    response_text = apply_skills(response_text)

    return response_text


def chat_with_context_by_api_key(
    api_key,
    message,
    document_context,
    conversation_history,
    raw_document_text="",
    pdf_base64="",
):
    """Chat using the LLM adapter resolved from an API key.

    Args:
        api_key: The API key string (UUID)
        message: The user's chat message
        document_context: Extracted document content
        conversation_history: List of previous messages [{role, content}]
        raw_document_text: Raw OCR text from LLMWhisperer (optional)
        pdf_base64: Base64-encoded PDF file (optional). When provided,
            the PDF pages are rendered as images and sent to the vision
            model so it can see the actual document layout.

    Returns:
        str: The LLM's response text
    """
    adapter_instance = _resolve_llm_adapter_from_api_key(api_key)

    pdf_images = None
    if pdf_base64:
        try:
            pdf_bytes = base64.b64decode(pdf_base64)
            pdf_images = _pdf_bytes_to_base64_images(
                pdf_bytes, max_pages=2, dpi=72
            )
            if pdf_images:
                logger.info(
                    "Vision enabled: %d PDF page images will be sent to LLM",
                    len(pdf_images),
                )
        except Exception as e:
            logger.warning("Failed to decode PDF for vision: %s", e)

    return _call_llm(
        adapter_instance,
        message,
        document_context,
        conversation_history,
        raw_document_text=raw_document_text,
        pdf_images=pdf_images,
    )

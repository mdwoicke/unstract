import json
import logging
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

logger = logging.getLogger(__name__)


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


def _call_llm(
    adapter_instance,
    message,
    document_context,
    conversation_history,
    raw_document_text="",
):
    """Call LLM using an adapter instance.

    Args:
        adapter_instance: AdapterInstance with adapter_type="LLM"
        message: The user's chat message
        document_context: Extracted document content
        conversation_history: List of previous messages [{role, content}]
        raw_document_text: Raw OCR text from LLMWhisperer (optional)

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
    system_content += (
        f"--- EXTRACTED DATA (structured) ---\n{document_context}\n"
    )
    if raw_document_text:
        system_content += (
            f"--- ORIGINAL DOCUMENT TEXT ---\n{raw_document_text}\n"
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

    messages.append({"role": "user", "content": message})

    litellm.drop_params = True
    response = litellm.completion(messages=messages, **completion_kwargs)
    return response["choices"][0]["message"]["content"]


def chat_with_context_by_api_key(
    api_key,
    message,
    document_context,
    conversation_history,
    raw_document_text="",
):
    """Chat using the LLM adapter resolved from an API key.

    Args:
        api_key: The API key string (UUID)
        message: The user's chat message
        document_context: Extracted document content
        conversation_history: List of previous messages [{role, content}]
        raw_document_text: Raw OCR text from LLMWhisperer (optional)

    Returns:
        str: The LLM's response text
    """
    adapter_instance = _resolve_llm_adapter_from_api_key(api_key)
    return _call_llm(
        adapter_instance,
        message,
        document_context,
        conversation_history,
        raw_document_text=raw_document_text,
    )

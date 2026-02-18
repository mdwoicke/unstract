import logging
from io import BytesIO

from django.core.files.uploadedfile import InMemoryUploadedFile
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from chatbot.chat_helper import chat_with_context_by_api_key, extract_document
from chatbot.serializers import ChatMessageSerializer, DocumentExtractSerializer

logger = logging.getLogger(__name__)


class DocumentExtractView(APIView):
    """Extract document content using an API deployment."""

    def post(self, request: Request) -> Response:
        serializer = DocumentExtractSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        api_deployment_id = serializer.validated_data["api_deployment_id"]
        file_obj = request.FILES.get("file")

        if not file_obj:
            # If no file uploaded, check for file_path (for files already
            # accessible to the system)
            file_path = serializer.validated_data.get("file_path", "")
            if not file_path:
                return Response(
                    {"error": "Either a file upload or file_path is required."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            # Create a minimal file object from the path for the deployment
            try:
                with open(file_path, "rb") as f:
                    content = f.read()
                file_name = file_path.split("/")[-1] or "document"
                file_obj = InMemoryUploadedFile(
                    file=BytesIO(content),
                    field_name="file",
                    name=file_name,
                    content_type="application/octet-stream",
                    size=len(content),
                    charset=None,
                )
            except FileNotFoundError:
                return Response(
                    {"error": f"File not found: {file_path}"},
                    status=status.HTTP_404_NOT_FOUND,
                )
            except PermissionError:
                return Response(
                    {"error": f"Permission denied reading: {file_path}"},
                    status=status.HTTP_403_FORBIDDEN,
                )

        try:
            document_context = extract_document(api_deployment_id, file_obj)
            return Response(
                {"document_context": document_context},
                status=status.HTTP_200_OK,
            )
        except Exception as e:
            logger.exception("Document extraction failed")
            return Response(
                {"error": str(e)},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )


class ChatView(APIView):
    """Chat with document context using the org's LLM adapter.

    Accepts Bearer API key auth (same key used for API deployments).
    Resolves the LLM adapter from the API key's organization.
    """

    authentication_classes = []
    permission_classes = [AllowAny]

    def post(self, request: Request) -> Response:
        # Extract Bearer token from Authorization header
        auth_header = request.META.get("HTTP_AUTHORIZATION", "")
        if not auth_header.startswith("Bearer "):
            return Response(
                {"error": "Authorization header with Bearer token is required."},
                status=status.HTTP_401_UNAUTHORIZED,
            )
        api_key = auth_header[7:].strip()

        serializer = ChatMessageSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        message = serializer.validated_data["message"]
        document_context = serializer.validated_data["document_context"]
        raw_document_text = serializer.validated_data.get("raw_document_text", "")
        pdf_base64 = serializer.validated_data.get("pdf_base64", "")
        conversation_history = serializer.validated_data.get(
            "conversation_history", []
        )

        try:
            response_text = chat_with_context_by_api_key(
                api_key=api_key,
                message=message,
                document_context=document_context,
                raw_document_text=raw_document_text,
                pdf_base64=pdf_base64,
                conversation_history=conversation_history,
            )
            return Response(
                {"response": response_text},
                status=status.HTTP_200_OK,
            )
        except Exception as e:
            logger.exception("Chat completion failed")
            return Response(
                {"error": str(e)},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )

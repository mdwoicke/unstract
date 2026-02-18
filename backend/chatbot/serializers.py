from rest_framework import serializers


class DocumentExtractSerializer(serializers.Serializer):
    api_deployment_id = serializers.UUIDField()
    file_path = serializers.CharField(max_length=1024, required=False, default="")


class ChatMessageSerializer(serializers.Serializer):
    message = serializers.CharField()
    document_context = serializers.CharField()
    raw_document_text = serializers.CharField(
        required=False,
        default="",
        allow_blank=True,
        help_text=(
            "Raw OCR text from the source document. Required for citations. "
            "Without this, the chatbot will answer without citations."
        ),
    )
    pdf_base64 = serializers.CharField(
        required=False,
        default="",
        allow_blank=True,
        help_text=(
            "Base64-encoded PDF file. When provided, the PDF pages are "
            "rendered as images and sent to the vision model so it can "
            "see the actual document layout for more accurate answers."
        ),
    )
    conversation_history = serializers.ListField(
        child=serializers.DictField(), required=False, default=list
    )

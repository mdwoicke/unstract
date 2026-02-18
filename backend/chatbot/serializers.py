from rest_framework import serializers


class DocumentExtractSerializer(serializers.Serializer):
    api_deployment_id = serializers.UUIDField()
    file_path = serializers.CharField(max_length=1024, required=False, default="")


class ChatMessageSerializer(serializers.Serializer):
    message = serializers.CharField()
    document_context = serializers.CharField()
    raw_document_text = serializers.CharField(required=False, default="", allow_blank=True)
    conversation_history = serializers.ListField(
        child=serializers.DictField(), required=False, default=list
    )

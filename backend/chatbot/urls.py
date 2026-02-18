from django.urls import path

from chatbot.views import ChatView, DocumentExtractView

urlpatterns = [
    path("extract/", DocumentExtractView.as_view(), name="chatbot_extract"),
    path("chat/", ChatView.as_view(), name="chatbot_chat"),
]

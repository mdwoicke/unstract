import datetime
import os
import tempfile
from typing import Any

from flask import current_app as app

from unstract.prompt_service.constants import PromptServiceConstants as PSKeys
from unstract.prompt_service.constants import RetrievalStrategy
from unstract.prompt_service.core.retrievers.automerging import AutomergingRetriever
from unstract.prompt_service.core.retrievers.fusion import FusionRetriever
from unstract.prompt_service.core.retrievers.keyword_table import KeywordTableRetriever
from unstract.prompt_service.core.retrievers.recursive import RecursiveRetrieval
from unstract.prompt_service.core.retrievers.router import RouterRetriever
from unstract.prompt_service.core.retrievers.simple import SimpleRetriever
from unstract.prompt_service.core.retrievers.subquestion import SubquestionRetriever
from unstract.prompt_service.services.answer_prompt import AnswerPromptService
from unstract.prompt_service.utils.file_utils import FileUtils
from unstract.prompt_service.utils.metrics import Metrics
from unstract.sdk1.llm import LLM
from unstract.sdk1.vector_db import VectorDB


class RetrievalService:
    @staticmethod
    def _find_original_pdf(
        file_path: str,
        execution_source: str,
        doc_name: str = "",
        tool_id: str = "",
    ) -> bytes | None:
        """Try to locate and read the original PDF from storage.

        Searches multiple known path patterns:
        1. IDE (Prompt Studio): derive from extract text path
        2. IDE fallback: construct from tool_id + doc_name
        3. TOOL (API deployment): try permanent storage with tool_id

        Returns:
            PDF bytes if found, None otherwise.
        """
        app.logger.debug(
            "[Vision] _find_original_pdf: file_path=%s "
            "doc_name=%s tool_id=%s execution_source=%s",
            file_path, doc_name, tool_id, execution_source,
        )
        # Strategy 1: Derive from the extracted text path
        # e.g. .../EXTRACT/doc.txt -> .../doc.pdf
        _extract_sep = None
        if "/EXTRACT/" in file_path:
            _extract_sep = "/EXTRACT/"
        elif "/extract/" in file_path:
            _extract_sep = "/extract/"
        if _extract_sep is not None:
            parts = file_path.rsplit(_extract_sep, 1)
            if len(parts) == 2:
                base_name = os.path.splitext(parts[1])[0]
                pdf_path = f"{parts[0]}/{base_name}.pdf"
                try:
                    fs = FileUtils.get_fs_instance(
                        execution_source=execution_source,
                    )
                    data = fs.read(path=pdf_path, mode="rb")
                    if data:
                        app.logger.info(
                            "[Vision] Found PDF via extract path: %s",
                            pdf_path,
                        )
                        return data
                except Exception:
                    pass

        # Strategy 2: Use permanent storage with tool_id + doc_name
        # Path: unstract/prompt-studio-data/{org}/{user}/{tool_id}/{doc_name}
        if doc_name and tool_id and doc_name.lower().endswith(".pdf"):
            # Extract org from file_path (3rd path component, index 2)
            # e.g. "unstract/execution/mock_org/..." -> "mock_org"
            path_parts = file_path.split("/")
            org = None
            if len(path_parts) >= 3:
                org = path_parts[2]  # e.g. "mock_org"
            if org:
                from unstract.prompt_service.constants import (
                    ExecutionSource,
                    FileStorageKeys,
                )
                from unstract.sdk1.file_storage.constants import StorageType
                from unstract.sdk1.file_storage.env_helper import EnvHelper

                try:
                    fs = EnvHelper.get_storage(
                        storage_type=StorageType.PERMANENT,
                        env_name=FileStorageKeys.PERMANENT_REMOTE_STORAGE,
                    )
                    # Try common user paths
                    for user_id in ["mock_user_id"]:
                        pdf_path = (
                            f"unstract/prompt-studio-data/{org}/"
                            f"{user_id}/{tool_id}/{doc_name}"
                        )
                        try:
                            data = fs.read(path=pdf_path, mode="rb")
                            if data:
                                app.logger.info(
                                    "[Vision] Found PDF in permanent "
                                    "storage: %s",
                                    pdf_path,
                                )
                                return data
                        except Exception as e:
                            app.logger.debug(
                                "[Vision] Strategy 2: failed for "
                                "path=%s: %s", pdf_path, e,
                            )
                            continue
                except Exception as e:
                    app.logger.debug(
                        "[Vision] Strategy 2: storage error: %s", e,
                    )

        # Strategy 3: API-uploaded PDF in shared storage
        # file_path: unstract/execution/{org}/{workflow_id}/{execution_id}/{file_exec_id}/EXTRACT
        # target:    unstract/api/{org}/{workflow_id}/{execution_id}/{doc_name}
        if doc_name:
            path_parts = file_path.split("/")
            # Expect at least: unstract / execution / org / workflow_id / execution_id
            if len(path_parts) >= 5 and path_parts[1] == "execution":
                org = path_parts[2]
                workflow_id = path_parts[3]
                execution_id = path_parts[4]
                from unstract.prompt_service.constants import FileStorageKeys
                from unstract.sdk1.file_storage.constants import StorageType
                from unstract.sdk1.file_storage.env_helper import EnvHelper

                try:
                    fs = EnvHelper.get_storage(
                        storage_type=StorageType.PERMANENT,
                        env_name=FileStorageKeys.PERMANENT_REMOTE_STORAGE,
                    )
                    pdf_path = (
                        f"unstract/api/{org}/{workflow_id}/{execution_id}/{doc_name}"
                    )
                    try:
                        data = fs.read(path=pdf_path, mode="rb")
                        if data:
                            app.logger.info(
                                "[Vision] Found PDF in API storage: %s",
                                pdf_path,
                            )
                            return data
                    except Exception as e:
                        app.logger.debug(
                            "[Vision] Strategy 3: failed for path=%s: %s",
                            pdf_path, e,
                        )
                except Exception as e:
                    app.logger.debug(
                        "[Vision] Strategy 3: storage error: %s", e,
                    )

        app.logger.debug("[Vision] PDF not found in any location")
        return None

    @staticmethod
    def perform_retrieval(  # type:ignore
        tool_settings: dict[str, Any],
        output: dict[str, Any],
        doc_id: str,
        llm: LLM,
        vector_db: VectorDB,
        retrieval_type: str,
        metadata: dict[str, Any],
        chunk_size: int,
        execution_source: str,
        file_path: str,
        context_retrieval_metrics: dict[str, Any],
        doc_name: str = "",
        tool_id: str = "",
    ) -> tuple[str, list[str]]:
        prompt_name = output.get(PSKeys.NAME, "<unknown>")
        vector_db_id = (
            getattr(vector_db, "_adapter_instance_id", None) if vector_db else None
        )
        app.logger.info(
            f"[Retrieval] prompt='{prompt_name}' doc_id={doc_id} "
            f"chunk_size={chunk_size} method={'complete_context' if chunk_size == 0 else 'chunked'}"
            + (f" vector_db={vector_db_id}" if vector_db_id else "")
        )

        context: list[str]
        if chunk_size == 0:
            context = RetrievalService.retrieve_complete_context(
                execution_source=execution_source,
                file_path=file_path,
                context_retrieval_metrics=context_retrieval_metrics,
                prompt_key=prompt_name,
            )
        else:
            context = RetrievalService.run_retrieval(
                output=output,
                doc_id=doc_id,
                llm=llm,
                vector_db=vector_db,
                retrieval_type=retrieval_type,
                context_retrieval_metrics=context_retrieval_metrics,
            )

        # Generate PDF page images (used by both preprocessor and LLM)
        images = None
        pdf_bytes = RetrievalService._find_original_pdf(
            file_path=file_path,
            execution_source=execution_source,
            doc_name=doc_name,
            tool_id=tool_id,
        )
        if pdf_bytes:
            # Extract AcroForm field values and prepend to context.
            # Handles digitally-filled PDFs where field values live in the
            # AcroForm data layer rather than the text/OCR layer.
            try:
                from unstract.prompt_service.utils.pdf_form_fields import (
                    extract_acroform_fields,
                )

                form_text = extract_acroform_fields(pdf_bytes)
                if form_text:
                    app.logger.info(
                        "[Retrieval] AcroForm fields prepended for prompt '%s' "
                        "(%d chars)",
                        prompt_name,
                        len(form_text),
                    )
                    context = [form_text] + context
            except Exception as e:
                app.logger.warning(
                    "[Retrieval] AcroForm extraction failed: %s", e
                )

            # Render PDF pages as images for vision-capable LLMs
            try:
                from unstract.prompt_service.utils.pdf_vision import (
                    pdf_pages_to_base64,
                )

                with tempfile.NamedTemporaryFile(
                    suffix=".pdf", delete=False,
                ) as tmp:
                    tmp.write(pdf_bytes)
                    tmp_path = tmp.name
                try:
                    vision_max_pages = int(
                        os.environ.get("VISION_MAX_PAGES", "10")
                    )
                    vision_dpi = int(
                        os.environ.get("VISION_DPI", "150")
                    )
                    images = pdf_pages_to_base64(
                        tmp_path,
                        max_pages=vision_max_pages,
                        dpi=vision_dpi,
                    )
                finally:
                    os.unlink(tmp_path)

                if images:
                    app.logger.info(
                        "[Retrieval] Vision enabled: %d PDF page images "
                        "for prompt '%s'",
                        len(images),
                        prompt_name,
                    )
            except Exception as e:
                app.logger.warning(
                    "[Retrieval] Failed to render PDF for vision: %s", e
                )

        # Local VL model preprocessing with vision
        if os.environ.get("PREPROCESSOR_ENABLED", "true").lower() == "true":
            from unstract.prompt_service.utils.claude_preprocessor import (
                preprocess_context,
            )

            raw_context = "\n".join(context)
            reformatted = preprocess_context(
                raw_context, images=images,
            )
            if reformatted:
                app.logger.info(
                    "[Retrieval] Context preprocessed: "
                    "%d -> %d chars for prompt '%s'",
                    len(raw_context),
                    len(reformatted),
                    prompt_name,
                )
                context = [reformatted]

        answer = AnswerPromptService.construct_and_run_prompt(  # type:ignore
            tool_settings=tool_settings,
            output=output,
            llm=llm,
            context="\n".join(context),
            prompt="promptx",
            metadata=metadata,
            execution_source=execution_source,
            file_path=file_path,
            images=images,
        )
        return answer, context

    @staticmethod
    def run_retrieval(  # type:ignore
        output: dict[str, Any],
        doc_id: str,
        llm: LLM,
        vector_db: VectorDB,
        retrieval_type: str,
        context_retrieval_metrics: dict[str, Any],
    ) -> list[str]:
        context: set[str]
        prompt = output[PSKeys.PROMPTX]
        top_k = output[PSKeys.SIMILARITY_TOP_K]
        prompt_key = output[PSKeys.NAME]
        retrieval_start_time = datetime.datetime.now()

        # Map retrieval type to retriever class
        retriever_map = {
            RetrievalStrategy.SIMPLE.value: SimpleRetriever,
            RetrievalStrategy.SUBQUESTION.value: SubquestionRetriever,
            RetrievalStrategy.FUSION.value: FusionRetriever,
            RetrievalStrategy.RECURSIVE.value: RecursiveRetrieval,
            RetrievalStrategy.ROUTER.value: RouterRetriever,
            RetrievalStrategy.KEYWORD_TABLE.value: KeywordTableRetriever,
            RetrievalStrategy.AUTOMERGING.value: AutomergingRetriever,
        }

        # Get the appropriate retriever class
        retriever_class = retriever_map.get(retrieval_type)
        if not retriever_class:
            raise ValueError(f"Unknown retrieval type: {retrieval_type}")

        # Create and execute retriever
        retriever = retriever_class(
            vector_db=vector_db,
            doc_id=doc_id,
            prompt=prompt,
            top_k=top_k,
            llm=llm,
        )
        context = retriever.retrieve()
        elapsed = Metrics.elapsed_time(start_time=retrieval_start_time)
        context_retrieval_metrics[prompt_key] = {"time_taken(s)": elapsed}

        app.logger.info(
            f"[Retrieval] prompt='{prompt_key}' doc_id={doc_id} "
            f"strategy='{retrieval_type}' top_k={top_k} chunks={len(context)} time={elapsed:.3f}s"
        )

        return list(context)

    @staticmethod
    def retrieve_complete_context(
        execution_source: str,
        file_path: str,
        context_retrieval_metrics: dict[str, Any],
        prompt_key: str,
    ) -> list[str]:
        """Loads full context from raw file for zero chunk size retrieval.

        Args:
            execution_source: Source of execution (e.g., "api", "workflow").
            file_path: Path to the extracted text file.
            context_retrieval_metrics: Dict to store retrieval timing metrics
                (modified in-place).
            prompt_key: Name/identifier of the prompt for metrics tracking.

        Returns:
            List containing the complete file content as a single string.
        """
        fs_instance = FileUtils.get_fs_instance(execution_source=execution_source)
        retrieval_start_time = datetime.datetime.now()
        context = fs_instance.read(path=file_path, mode="r")
        elapsed = Metrics.elapsed_time(start_time=retrieval_start_time)
        context_retrieval_metrics[prompt_key] = {"time_taken(s)": elapsed}

        app.logger.info(
            f"[Retrieval] prompt='{prompt_key}' complete_context "
            f"chars={len(context)} time={elapsed:.3f}s"
        )

        return [context]

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import type { PDFDocumentProxy } from "pdfjs-dist";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { ModuleEmptyState } from "../../components/ui/feedback/ModuleEmptyState";
import { useI18n } from "../../i18n";
import { readRemotePreview } from "../files/fileApi";
import { LOCAL_CONNECTION_ID } from "../files/utils";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

/** 知识库 PDF 预览允许的最大文件体积（50 MiB）。 */
const PDF_MAX_BYTES = 50 * 1024 * 1024;

/** A4 纵向大致高宽比，用于懒加载占位，避免滚动条跳动。 */
const PAGE_ASPECT_RATIO = 1.414;

interface KnowledgePdfPreviewProps {
  pdfPath: string;
  title: string;
}

interface PdfScrollPageProps {
  pageNumber: number;
  width: number;
  scrollRoot: RefObject<HTMLDivElement | null>;
  mustRender?: boolean;
  onHostRef: (pageNumber: number, node: HTMLDivElement | null) => void;
}

function PdfScrollPage({
  pageNumber,
  width,
  scrollRoot,
  mustRender = false,
  onHostRef,
}: PdfScrollPageProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [renderPage, setRenderPage] = useState(mustRender);
  const placeholderHeight = Math.round(width * PAGE_ASPECT_RATIO);

  useEffect(() => {
    if (mustRender) {
      setRenderPage(true);
    }
  }, [mustRender]);

  const setHostRef = useCallback(
    (node: HTMLDivElement | null) => {
      hostRef.current = node;
      onHostRef(pageNumber, node);
    },
    [onHostRef, pageNumber],
  );

  useEffect(() => {
    if (renderPage) {
      return;
    }
    const root = scrollRoot.current;
    const host = hostRef.current;
    if (!root || !host) {
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setRenderPage(true);
        }
      },
      { root, rootMargin: "480px 0px" },
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, [renderPage, scrollRoot]);

  return (
    <div
      ref={setHostRef}
      className="knowledge-pdf-preview__page-host"
      data-page={pageNumber}
      style={renderPage ? undefined : { minHeight: placeholderHeight }}
    >
      {renderPage ? (
        <Page
          pageNumber={pageNumber}
          width={width}
          renderTextLayer
          renderAnnotationLayer
          className="knowledge-pdf-preview__page"
        />
      ) : null}
    </div>
  );
}

/** 初始预渲染页数（其余页懒加载）。 */
const INITIAL_RENDERED_PAGES = 2;

function createInitialRenderedPages(): Set<number> {
  return new Set(Array.from({ length: INITIAL_RENDERED_PAGES }, (_, index) => index + 1));
}

export function KnowledgePdfPreview({ pdfPath, title }: KnowledgePdfPreviewProps) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const pageHostsRef = useRef<Map<number, HTMLDivElement>>(new Map());

  const [viewportWidth, setViewportWidth] = useState(0);
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null);
  const [fileLoadError, setFileLoadError] = useState<string | null>(null);
  const [loadingFile, setLoadingFile] = useState(true);
  const [numPages, setNumPages] = useState(0);
  const [visiblePage, setVisiblePage] = useState(1);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [renderedPages, setRenderedPages] = useState<Set<number>>(createInitialRenderedPages);

  useEffect(() => {
    let cancelled = false;
    setLoadingFile(true);
    setFileLoadError(null);
    setRenderError(null);
    setVisiblePage(1);
    setRenderedPages(createInitialRenderedPages());

    const load = async () => {
      try {
        const bytes = await readRemotePreview(LOCAL_CONNECTION_ID, pdfPath, PDF_MAX_BYTES);
        if (!cancelled) {
          pageHostsRef.current.clear();
          setNumPages(0);
          setPdfData(Uint8Array.from(bytes));
        }
      } catch (error) {
        if (!cancelled) {
          setFileLoadError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!cancelled) {
          setLoadingFile(false);
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [pdfPath]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    const updateWidth = () => {
      setViewportWidth(element.clientWidth);
    };
    updateWidth();

    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const file = useMemo(() => (pdfData ? { data: pdfData } : null), [pdfData]);
  const pageWidth = Math.max(viewportWidth - 32, 240);
  const showOverlay = loadingFile || (Boolean(file) && numPages === 0 && !fileLoadError && !renderError);
  const overlayMessage = loadingFile
    ? t("knowledge.importPreview.loading")
    : t("knowledge.importPreview.rendering");

  const handleDocumentLoadSuccess = useCallback(({ numPages: total }: PDFDocumentProxy) => {
    setNumPages(total);
    setVisiblePage(1);
    setRenderedPages(createInitialRenderedPages());
    setRenderError(null);
    if (viewportRef.current) {
      viewportRef.current.scrollTop = 0;
    }
  }, []);

  const ensurePagesRendered = useCallback((...pageNumbers: number[]) => {
    setRenderedPages((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const pageNumber of pageNumbers) {
        if (pageNumber >= 1 && !next.has(pageNumber)) {
          next.add(pageNumber);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  const scrollToPage = useCallback(
    (pageNumber: number) => {
      if (pageNumber < 1 || (numPages > 0 && pageNumber > numPages)) {
        return;
      }

      ensurePagesRendered(pageNumber, pageNumber - 1, pageNumber + 1);
      setVisiblePage(pageNumber);

      const tryScroll = (attempt = 0) => {
        const host = pageHostsRef.current.get(pageNumber);
        const viewport = viewportRef.current;
        if (host && viewport) {
          viewport.scrollTo({
            top: Math.max(host.offsetTop - 16, 0),
            behavior: "smooth",
          });
          return;
        }
        if (attempt < 24) {
          requestAnimationFrame(() => tryScroll(attempt + 1));
        }
      };

      requestAnimationFrame(() => tryScroll());
    },
    [ensurePagesRendered, numPages],
  );

  const handleItemClick = useCallback(
    ({ pageNumber }: { pageNumber: number }) => {
      scrollToPage(pageNumber);
    },
    [scrollToPage],
  );

  const handleDocumentLoadError = useCallback((error: Error) => {
    setRenderError(error.message);
  }, []);

  const registerPageHost = useCallback((pageNumber: number, node: HTMLDivElement | null) => {
    if (node) {
      pageHostsRef.current.set(pageNumber, node);
    } else {
      pageHostsRef.current.delete(pageNumber);
    }
  }, []);

  const updateVisiblePage = useCallback(() => {
    const root = viewportRef.current;
    if (!root || numPages === 0) {
      return;
    }

    const center = root.scrollTop + root.clientHeight / 2;
    let bestPage = 1;
    let bestDistance = Number.POSITIVE_INFINITY;

    pageHostsRef.current.forEach((element, pageNumber) => {
      const pageCenter = element.offsetTop + element.offsetHeight / 2;
      const distance = Math.abs(pageCenter - center);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestPage = pageNumber;
      }
    });

    setVisiblePage(bestPage);
  }, [numPages]);

  useEffect(() => {
    updateVisiblePage();
  }, [numPages, pageWidth, updateVisiblePage]);

  useEffect(() => {
    const root = viewportRef.current;
    if (!root || numPages === 0) {
      return;
    }

    root.addEventListener("scroll", updateVisiblePage, { passive: true });
    return () => root.removeEventListener("scroll", updateVisiblePage);
  }, [numPages, updateVisiblePage]);

  const fatalError = fileLoadError ?? renderError;

  return (
    <div
      ref={containerRef}
      className="knowledge-pdf-preview"
      aria-label={t("knowledge.importPreview.pdfLabel", { title })}
    >
      {numPages > 0 && (
        <div className="knowledge-pdf-preview__status" aria-live="polite">
          {t("knowledge.importPreview.pageIndicator", {
            page: visiblePage,
            total: numPages,
          })}
        </div>
      )}

      <div ref={viewportRef} className="knowledge-pdf-preview__viewport">
        {fatalError ? (
          <ModuleEmptyState
            preset="document"
            title={
              fileLoadError
                ? t("knowledge.importPreview.loadError")
                : t("knowledge.importPreview.renderError")
            }
            desc={fatalError}
          />
        ) : file ? (
          <>
            {showOverlay ? (
              <div className="knowledge-pdf-preview__overlay" aria-hidden="true">
                <span className="knowledge-pdf-preview__overlay-text">{overlayMessage}</span>
              </div>
            ) : null}
            <Document
              file={file}
              onLoadSuccess={handleDocumentLoadSuccess}
              onLoadError={handleDocumentLoadError}
              onItemClick={handleItemClick}
              loading={null}
              error={null}
              className="knowledge-pdf-preview__document"
            >
              {numPages > 0 ? (
                <div className="knowledge-pdf-preview__pages">
                  {Array.from({ length: numPages }, (_, index) => {
                    const pageNumber = index + 1;
                    return (
                      <PdfScrollPage
                        key={`${pdfPath}:${pageNumber}`}
                        pageNumber={pageNumber}
                        width={pageWidth}
                        scrollRoot={viewportRef}
                        mustRender={renderedPages.has(pageNumber)}
                        onHostRef={registerPageHost}
                      />
                    );
                  })}
                </div>
              ) : null}
            </Document>
          </>
        ) : showOverlay ? (
          <div className="knowledge-pdf-preview__overlay" aria-hidden="true">
            <span className="knowledge-pdf-preview__overlay-text">{overlayMessage}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

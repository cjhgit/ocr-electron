import { useContext, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { StreamdownContext } from "../../index";
import { useIcons } from "../icon-context";
import { useCn } from "../prefix-context";
import { lockBodyScroll, unlockBodyScroll } from "../scroll-lock";
import { useTranslations } from "../translations-context";
import { CodeBlockCopyButton } from "./copy-button";
import { CodeBlockDownloadButton } from "./download-button";
import { CodeBlock } from "./index";

interface CodeBlockFullscreenButtonProps {
  code: string;
  language: string;
  lineNumbers?: boolean;
  startLine?: number;
  className?: string;
  showCopy?: boolean;
  showDownload?: boolean;
}

export const CodeBlockFullscreenButton = ({
  code,
  language,
  lineNumbers,
  startLine,
  className,
  showCopy = true,
  showDownload = true,
}: CodeBlockFullscreenButtonProps) => {
  const { Maximize2Icon, XIcon } = useIcons();
  const cn = useCn();
  const [isFullscreen, setIsFullscreen] = useState(false);
  const { isAnimating } = useContext(StreamdownContext);
  const t = useTranslations();

  const handleOpen = () => {
    setIsFullscreen(true);
  };

  const handleClose = () => {
    setIsFullscreen(false);
  };

  useEffect(() => {
    if (isFullscreen) {
      lockBodyScroll();

      const handleEsc = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          setIsFullscreen(false);
        }
      };

      document.addEventListener("keydown", handleEsc);
      return () => {
        document.removeEventListener("keydown", handleEsc);
        unlockBodyScroll();
      };
    }
  }, [isFullscreen]);

  return (
    <>
      <button
        className={cn(
          "cursor-pointer p-1 text-muted-foreground transition-all hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        disabled={isAnimating}
        onClick={handleOpen}
        title={t.viewFullscreen}
        type="button"
      >
        <Maximize2Icon size={14} />
      </button>

      {isFullscreen
        ? createPortal(
            // biome-ignore lint/a11y/noNoninteractiveElementInteractions: "dialog overlay needs click-to-dismiss"
            <div
              aria-label={t.viewFullscreen}
              aria-modal="true"
              className={cn("fixed inset-0 z-50 flex flex-col bg-background")}
              data-streamdown="code-block-fullscreen"
              onClick={handleClose}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  handleClose();
                }
              }}
              role="dialog"
            >
              {/* biome-ignore lint/a11y/noStaticElementInteractions: "div with role=presentation is used for event propagation control" */}
              <div
                className={cn("flex h-full flex-col")}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
                role="presentation"
              >
                <div className={cn("flex items-center justify-end gap-1 p-4")}>
                  {showCopy ? <CodeBlockCopyButton code={code} /> : null}
                  {showDownload ? (
                    <CodeBlockDownloadButton code={code} language={language} />
                  ) : null}
                  <button
                    className={cn(
                      "rounded-md p-1 text-muted-foreground transition-all hover:bg-muted hover:text-foreground"
                    )}
                    onClick={handleClose}
                    title={t.exitFullscreen}
                    type="button"
                  >
                    <XIcon size={20} />
                  </button>
                </div>
                <div className={cn("flex-1 overflow-auto p-4 pt-0")}>
                  <CodeBlock
                    code={code}
                    language={language}
                    lineNumbers={lineNumbers}
                    startLine={startLine}
                  />
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  );
};

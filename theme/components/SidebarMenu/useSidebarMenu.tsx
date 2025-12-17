import { useRef, useState } from "react";
import { useI18n } from "@rspress/core/runtime";
import {
  useDynamicToc,
  ReadPercent,
  SvgWrapper,
  IconArrowRight,
} from "@rspress/core/theme-original";

export function useSidebarMenu() {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isOutlineOpen, setIsOutlineOpen] = useState(false);
  const sidebarLayoutRef = useRef<HTMLElement>(null);
  const asideLayoutRef = useRef<HTMLElement>(null);

  const headers = useDynamicToc();
  const t = useI18n();

  const toggleOutline = () => {
    setIsOutlineOpen((prev) => !prev);
    if (isSidebarOpen) {
      setIsSidebarOpen(false);
    }
  };

  const sidebarMenu = (
    <div className="rp-doc-layout__menu">
      <button
        type="button"
        disabled={headers.length === 0}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          toggleOutline();
        }}
        className="rp-sidebar-menu__right"
      >
        <span>{t("outlineTitle")}</span>
        <ReadPercent size={14} strokeWidth={2} />
        {/* TODO: discussion */}
        {headers.length !== 0 && (
          <SvgWrapper
            icon={IconArrowRight}
            style={{
              transform: isOutlineOpen ? "rotate(90deg)" : "rotate(0deg)",
              transition: "transform 0.2s ease-out",
            }}
          />
        )}
      </button>
    </div>
  );

  return {
    isSidebarOpen,
    isOutlineOpen,
    sidebarMenu,
    asideLayoutRef,
    sidebarLayoutRef,
    toggleOutline,
  };
}

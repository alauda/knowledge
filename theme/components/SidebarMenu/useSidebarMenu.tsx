import React from 'react';
import { useEffect, useRef, useState } from 'react';

export function useSidebarMenu() {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isOutlineOpen, setIsOutlineOpen] = useState(false);
  const sidebarLayoutRef = useRef<HTMLElement>(null);
  const asideLayoutRef = useRef<HTMLElement>(null);

  // 移动端菜单切换逻辑
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      
      // 如果点击的是菜单按钮，不关闭
      if (target.closest('.rp-doc-layout__menu-button')) {
        return;
      }

      // 如果点击在侧边栏外部，关闭侧边栏
      if (
        sidebarLayoutRef.current &&
        !sidebarLayoutRef.current.contains(target) &&
        !target.closest('.rp-doc-layout__menu')
      ) {
        setIsSidebarOpen(false);
      }

      // 如果点击在大纲外部，关闭大纲
      if (
        asideLayoutRef.current &&
        !asideLayoutRef.current.contains(target) &&
        !target.closest('.rp-doc-layout__menu')
      ) {
        setIsOutlineOpen(false);
      }
    };

    // 只在移动端添加点击外部关闭逻辑
    const isMobile = window.innerWidth <= 768;
    if (isMobile) {
      document.addEventListener('click', handleClickOutside);
      return () => {
        document.removeEventListener('click', handleClickOutside);
      };
    }
  }, []);

  // 切换侧边栏
  const toggleSidebar = () => {
    setIsSidebarOpen((prev) => !prev);
    if (isOutlineOpen) {
      setIsOutlineOpen(false);
    }
  };

  // 切换大纲
  const toggleOutline = () => {
    setIsOutlineOpen((prev) => !prev);
    if (isSidebarOpen) {
      setIsSidebarOpen(false);
    }
  };

  // 生成菜单按钮（仅在移动端显示）
  const sidebarMenu = (
    <div className="rp-doc-layout__menu">
      <button
        className="rp-doc-layout__menu-button"
        onClick={toggleSidebar}
        aria-label="Toggle sidebar"
        aria-expanded={isSidebarOpen}
        type="button"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 18 18"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M2 4h14M2 9h14M2 14h14"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </button>
      <button
        className="rp-doc-layout__menu-button"
        onClick={toggleOutline}
        aria-label="Toggle outline"
        aria-expanded={isOutlineOpen}
        type="button"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 18 18"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M3 3h12M3 9h12M3 15h12"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );

  return {
    isSidebarOpen,
    isOutlineOpen,
    sidebarMenu,
    asideLayoutRef,
    sidebarLayoutRef,
    toggleSidebar,
    toggleOutline,
  };
}


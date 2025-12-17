import { useFrontmatter } from '@rspress/core/runtime';
import {
  DocContent,
  DocFooter,
  Outline,
  Overview,
  Sidebar,
  useWatchToc,
} from '@rspress/core/theme-original';
import clsx from 'clsx';
import React from 'react';
import { useSidebarMenu } from '../../components/SidebarMenu';

export interface DocLayoutProps {
  beforeSidebar?: React.ReactNode;
  afterSidebar?: React.ReactNode;
  beforeDocFooter?: React.ReactNode;
  afterDocFooter?: React.ReactNode;
  beforeDoc?: React.ReactNode;
  afterDoc?: React.ReactNode;
  beforeDocContent?: React.ReactNode;
  afterDocContent?: React.ReactNode;
  beforeOutline?: React.ReactNode;
  afterOutline?: React.ReactNode;
  navTitle?: React.ReactNode;
  components?: Record<string, React.FC>;
}

export function DocLayout(props: DocLayoutProps) {
  const {
    beforeDocFooter,
    afterDocFooter,
    beforeDoc,
    afterDoc,
    beforeDocContent,
    afterDocContent,
    beforeOutline,
    afterOutline,
    beforeSidebar,
    afterSidebar,
    components,
  } = props;
  const { frontmatter } = useFrontmatter();

  const isOverviewPage = frontmatter?.overview ?? false;

  const showSidebar = false;
  const showDocFooter = false;
  
  const { outline: showOutline = true, pageType } = frontmatter || {};

  const isDocWide = pageType === 'doc-wide';

  const {
    isOutlineOpen,
    isSidebarOpen,
    sidebarMenu,
    asideLayoutRef,
    sidebarLayoutRef,
  } = useSidebarMenu();

  const { rspressDocRef } = useWatchToc();

  return (
    <>
      <div className="rp-doc-layout__menu">{sidebarMenu}</div>
      {beforeDoc}
      <div className="rp-doc-layout__container">
        {/* Sidebar - 强制隐藏 */}
        {showSidebar ? (
          <aside
            className={clsx(
              'rp-doc-layout__sidebar',
              isSidebarOpen && 'rp-doc-layout__sidebar--open',
              'rp-scrollbar',
            )}
            ref={sidebarLayoutRef}
          >
            {beforeSidebar}
            <Sidebar />
            {afterSidebar}
          </aside>
        ) : (
          <aside
            className="rp-doc-layout__sidebar-placeholder"
            style={isDocWide ? { width: '0' } : {}}
          ></aside>
        )}

        {/* Main document content */}
        {isOverviewPage ? (
          <>
            <main className="rp-doc-layout__overview">
              {beforeDocContent}
              <Overview
                content={<DocContent components={components} isOverviewPage />}
              />
              {afterDocContent}
            </main>
          </>
        ) : (
          <div
            className={clsx(
              'rp-doc-layout__doc',
              isDocWide && 'rp-doc-layout__doc--wide',
            )}
          >
            <main className="rp-doc-layout__doc-container">
              {beforeDocContent}
              <div className="rp-doc rspress-doc" ref={rspressDocRef}>
                <DocContent components={components} />
              </div>
              {afterDocContent}
              {beforeDocFooter}
              {/* DocFooter - 强制隐藏 */}
              {showDocFooter && <DocFooter />}
              {afterDocFooter}
            </main>
          </div>
        )}

        {/* Right outline - 保留，可通过 frontmatter 控制 */}
        {isOverviewPage ? null : showOutline ? (
          <aside
            className={clsx(
              'rp-doc-layout__outline',
              isOutlineOpen && 'rp-doc-layout__outline--open',
              'rp-scrollbar',
            )}
            ref={asideLayoutRef}
          >
            {beforeOutline}
            <Outline />
            {afterOutline}
          </aside>
        ) : (
          <aside
            className="rp-doc-layout__outline-placeholder"
            style={isDocWide ? { width: '0' } : {}}
          ></aside>
        )}
      </div>

      {afterDoc}
    </>
  );
}


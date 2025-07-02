import { NoSSR, usePageData } from "@rspress/runtime";
import { ReactNode } from "react";

import { HomeBanner } from "../../components/HomeBanner";
import { HomeContent } from "../../components/HomeContent";
import { SearchProvider } from "../../hooks/Search";

const HomeLayout: React.FC<{ children: ReactNode }> = ({ children }) => {
  return (
    <div className="m-auto w-2/3 flex flex-col items-center px-3">
      {children}
    </div>
  );
};

export default () => {
  const { siteData } = usePageData();
  const { message } = siteData.themeConfig.footer || {};

  return (
    <NoSSR>
      <SearchProvider>
        <HomeLayout>
          <HomeBanner className="flex items-stretch justify-between w-full mt-6 mb-20"></HomeBanner>
          <HomeContent></HomeContent>
          <footer className="rp-mt-12 rp-py-8 rp-px-6 sm:rp-p-8 rp-w-full rp-border-t rp-border-solid rp-border-divider-light">
            <div className="rp-m-auto rp-w-full rp-text-center">
              <div className="rp-font-medium rp-text-sm rp-text-text-2" />
              {message}
            </div>
          </footer>
        </HomeLayout>
      </SearchProvider>
    </NoSSR>
  );
};

import { usePageData } from "@rspress/core/runtime";
import { ReactNode } from "react";

import { HomeBanner } from "../../components/HomeBanner";
import { HomeContent } from "../../components/HomeContent";
import React from "react";

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
    <HomeLayout>
      <HomeBanner className="flex items-stretch justify-between w-full mt-6 mb-20"></HomeBanner>
      <HomeContent></HomeContent>
      <footer className="home-footer">
        <div className="home-footer__content">
          {message}
        </div>
      </footer>
    </HomeLayout>
  );
};

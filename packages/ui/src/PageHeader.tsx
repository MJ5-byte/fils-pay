import { createContext, useContext, type ReactNode } from "react";
import { IconChevronLeft } from "./icons.js";
export const PageHeaderSection = createContext("Merchant dashboard");

export function PageHeader({ title, lede, figure, actions, back, status, toolbar, eyebrow }: {
  title: string; eyebrow?: string; lede?: ReactNode; figure?: ReactNode; actions?: ReactNode; back?: ReactNode; status?: ReactNode; toolbar?: ReactNode;
}) {
  const section = useContext(PageHeaderSection);
  return <header className="fp-page-header">
    {back ? typeof back === "string" ? <a className="fp-page-back" href={back}><IconChevronLeft />Back</a> : <div className="fp-page-back">{back}</div> : null}
    <div className="fp-page-heading"><p className="fp-eyebrow">{eyebrow ?? section}</p><div className="fp-page-title-line"><h1>{title}</h1>{status}</div></div>
    {lede ? <p className="fp-page-lede">{lede}</p> : null}
    {figure ? <div className="fp-page-figure">{figure}</div> : null}
    {actions ? <div className="fp-page-actions">{actions}</div> : null}
    {toolbar ? <div className="fp-page-toolbar">{toolbar}</div> : null}
  </header>;
}

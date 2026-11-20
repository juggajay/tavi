import { set } from "../store";

export function PageBack() {
  return <div className="page-bar"><button className="link-btn" onClick={() => set({ page: "chat", viewer: null })}><span aria-hidden="true">&larr;</span>Back to conversation</button></div>;
}

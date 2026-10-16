import { Fragment, type ReactNode } from "react";
import { tParts, type MessageId } from "../shared/text";

/** Keep a sentence reorderable by translators while preserving styled values. */
export function TextParts({ id, values }: { id: MessageId; values: Readonly<Record<string, ReactNode>> }) {
  const params = Object.fromEntries(Object.keys(values).map(name => [name, ""]));
  return <>{tParts(id, params).map((part, index) => <Fragment key={index}>{part.param ? values[part.param] : part.text}</Fragment>)}</>;
}

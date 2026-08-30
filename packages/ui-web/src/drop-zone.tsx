"use client";

import type * as React from "react";
import {
  composeRenderProps,
  DropZone as DropZonePrimitive,
  FileTrigger as FileTriggerPrimitive,
  Text,
  type DropZoneProps as DropZonePrimitiveProps,
  type FileTriggerProps as FileTriggerPrimitiveProps,
} from "react-aria-components";

import { Button } from "./button";
import { cn } from "./cn";

/**
 * A drop target for files.
 *
 * React Aria's DropZone is used rather than raw dragover/drop handlers because
 * it also exposes the drop target to keyboard and screen-reader users, who
 * cannot perform a pointer drag at all. Dropping is therefore an enhancement
 * over the file picker rather than the only way in.
 */

export type DropZoneProps = DropZonePrimitiveProps;

function DropZone({ className, ...props }: DropZoneProps) {
  return (
    <DropZonePrimitive
      data-slot="drop-zone"
      className={composeRenderProps(className, (className) => cn("cn-drop-zone", className))}
      {...props}
    />
  );
}

export type FileTriggerProps = FileTriggerPrimitiveProps;

/**
 * Opens the platform file picker from any pressable child.
 *
 * Re-exported rather than wrapped: it renders a visually hidden `<input
 * type="file">` and no element of its own, so there is nothing to style.
 */
const FileTrigger = FileTriggerPrimitive;

export interface FileDropZoneProps extends Omit<
  DropZoneProps,
  "children" | "onDrop" | "className"
> {
  /** Called with the accepted files, from either a drop or the picker. */
  onSelect: (files: File[]) => void;
  /** Media types to accept, e.g. `["image/jpeg", "video/mp4"]`. */
  acceptedFileTypes?: ReadonlyArray<string>;
  allowsMultiple?: boolean;
  /** The prompt shown in the resting state. */
  label: React.ReactNode;
  /** Supporting copy — accepted formats, size ceiling. */
  description?: React.ReactNode;
  /** Label for the picker button. */
  buttonLabel?: string;
  className?: string;
}

/**
 * The composed file input: a drop target wrapping a picker button.
 *
 * A drop carrying no file (dragged text, a directory) resolves to an empty
 * list and is ignored, so `onSelect` only ever sees real files.
 */
function FileDropZone({
  onSelect,
  acceptedFileTypes,
  allowsMultiple = false,
  label,
  description,
  buttonLabel = "Choose a file",
  className,
  ...props
}: FileDropZoneProps) {
  const accepts = (type: string | null | undefined) =>
    !acceptedFileTypes?.length || (type != null && acceptedFileTypes.includes(type));

  return (
    <DropZone
      className={className}
      getDropOperation={(types) =>
        !acceptedFileTypes?.length || acceptedFileTypes.some((type) => types.has(type))
          ? "copy"
          : "cancel"
      }
      onDrop={(event) => {
        // A narrowing loop rather than `.filter()`: `DropItem` is a union and
        // only the `file` member carries `getFile`.
        const dropped: Promise<File>[] = [];
        for (const item of event.items) {
          if (item.kind === "file" && accepts(item.type)) dropped.push(item.getFile());
        }
        if (!dropped.length) return;
        void Promise.all(dropped).then((files) => {
          onSelect(allowsMultiple ? files : files.slice(0, 1));
        });
      }}
      {...props}
    >
      <Text slot="label" className="cn-drop-zone-label">
        {label}
      </Text>
      {description ? <p className="cn-drop-zone-description">{description}</p> : null}
      <FileTrigger
        acceptedFileTypes={acceptedFileTypes}
        allowsMultiple={allowsMultiple}
        onSelect={(files) => {
          if (!files) return;
          const selected = Array.from(files).filter((file) => accepts(file.type));
          if (selected.length) onSelect(selected);
        }}
      >
        <Button variant="secondary" size="sm">
          {buttonLabel}
        </Button>
      </FileTrigger>
    </DropZone>
  );
}

export { DropZone, FileDropZone, FileTrigger };

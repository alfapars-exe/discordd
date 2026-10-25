/** FilePreview — Previews attached files before sending. Images show thumbnails. */

import { useEffect, useRef } from "react";

type FilePreviewProps = {
  files: File[];
  onRemove: (index: number) => void;
};

function FilePreview({ files, onRemove }: FilePreviewProps) {
  if (files.length === 0) return null;

  return (
    <div className="file-preview">
      {files.map((file, index) => (
        <FilePreviewItem key={index} file={file} onRemove={() => onRemove(index)} />
      ))}
    </div>
  );
}

type FilePreviewItemProps = {
  file: File;
  onRemove: () => void;
};

function FilePreviewItem({ file, onRemove }: FilePreviewItemProps) {
  const isImage = file.type.startsWith("image/");

  const imageRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    if (!isImage || !imageRef.current) return;
    const url = URL.createObjectURL(file);
    imageRef.current.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file, isImage]);

  return (
    <div className="file-preview-item">
      {/* Remove button */}
      <button className="file-preview-remove" onClick={onRemove}>
        ✕
      </button>

      {isImage ? (
        <img ref={imageRef} alt={file.name} />
      ) : (
        <span className="file-preview-name">{file.name}</span>
      )}
    </div>
  );
}

export default FilePreview;

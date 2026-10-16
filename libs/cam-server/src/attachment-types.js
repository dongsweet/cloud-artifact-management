const MIME_BY_EXTENSION = Object.freeze({
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pdf': 'application/pdf',
  '.wps': 'application/vnd.ms-works',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
});

export function attachmentExtension(fileName) {
  if (typeof fileName !== 'string') return null;
  const extension = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
  return Object.hasOwn(MIME_BY_EXTENSION, extension) ? extension : null;
}

export function attachmentContentType(fileName) {
  const extension = attachmentExtension(fileName);
  return extension ? MIME_BY_EXTENSION[extension] : 'application/octet-stream';
}

export function validAttachmentFileName(fileName) {
  return typeof fileName === 'string'
    && /^[\p{L}\p{N}_ .()\-]{1,180}\.(?:docx|pdf|wps|txt|md)$/iu.test(fileName)
    && !/[\\/\0]/u.test(fileName)
    && Boolean(attachmentExtension(fileName));
}

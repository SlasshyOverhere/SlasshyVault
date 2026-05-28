export const getZipCompressionLabel = (method?: number): string | null => {
  switch (method) {
    case 0:
      return "Store"
    case 8:
      return "Deflate"
    default:
      return null
  }
}

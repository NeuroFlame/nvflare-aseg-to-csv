import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'

// For GitHub Pages, set base to '/<repo-name>/' after you know it.
export default defineConfig({
  plugins: [react()],
  base: '/nvflare-aseg-to-csv/',
})

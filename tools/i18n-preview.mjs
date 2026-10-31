import {createServer} from 'vite';
import vue from '@vitejs/plugin-vue';
import {fileURLToPath} from 'node:url';
const server=await createServer({configFile:false,root:fileURLToPath(new URL('../',import.meta.url)),plugins:[vue()],resolve:{alias:[{find:/^vue$/,replacement:'vue/dist/vue.esm-bundler.js'}]},optimizeDeps:{entries:['tests/fixtures/i18n-preview.html']},server:{host:'127.0.0.1',port:5193,strictPort:true}});
await server.listen();console.log('Isolated i18n preview: http://127.0.0.1:5193/tests/fixtures/i18n-preview.html');


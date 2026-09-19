const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
async function loadProduction(file) {
    const context=vm.createContext({console,Date,performance}),cache=new Map();
    function load(id) {
        if(cache.has(id))return cache.get(id);
        const mod=new vm.SourceTextModule(fs.readFileSync(path.join(__dirname,'../../src',id),'utf8'),{identifier:id,context});cache.set(id,mod);return mod;
    }
    const mod=load(file);await mod.link(spec=>load(spec));await mod.evaluate();return mod.namespace;
}
module.exports={loadProduction};

import { mkdir, writeFile } from 'node:fs/promises';
/** Preserve exact project identities: duplicate passes cannot stand in for both motion modes. */
export default class CatalogReporter {
  async onTestRunEnd(modules, errors, reason) {
    const tests = modules.flatMap(module => [...module.children.allTests()].map(test => ({ file:module.relativeModuleId, project:test.project.name, name:test.name, state:test.result().state })));
    await mkdir('.tmp/catalog',{recursive:true});
    await writeFile('.tmp/catalog/motion.json',JSON.stringify({reason,errors:errors.map(error => String(error)),tests},null,2)+'\n');
  }
}

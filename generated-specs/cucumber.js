// Pending steps are reported but do not fail the run (strict: false).
module.exports = {
  default: {
    paths: ['features/**/*.feature'],
    requireModule: ['tsx/cjs'],
    require: ['test/steps/**/*.ts'],
    strict: false,
    format: ['progress']
  }
};

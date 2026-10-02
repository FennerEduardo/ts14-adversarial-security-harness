// Pending steps are reported but do not fail the run (strict: false).
module.exports = {
  default: {
    paths: ['features/**/*.feature'],
    requireModule: ['ts-node/register'],
    require: ['test/steps/**/*.ts'],
    strict: false,
    format: ['progress']
  }
};

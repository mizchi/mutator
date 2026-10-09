// Replaces `__VALUE__` with the configured number (like a define plugin).
module.exports = {
  createTransformer(options) {
    return {
      process(source) {
        return { code: source.replaceAll('__VALUE__', String(options.value)) };
      },
    };
  },
};

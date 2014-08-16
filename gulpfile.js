var gulp = require('gulp');
var browserify = require('gulp-browserify');
var rename = require('gulp-rename');

// Basic usage
gulp.task('scripts', function() {
    // Single entry point to browserify
    gulp.src('src/main.js')
        .pipe(browserify({
          debug : !gulp.env.production
        }))
        .pipe(rename('imit.js'))
        .pipe(gulp.dest('./dist/'))
});

gulp.task('default', ['scripts']);
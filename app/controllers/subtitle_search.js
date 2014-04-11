/**
 * @TODO : Sayfalama desteği
 */
var _ = require('underscore');
var request = require('request');
var jsdom = require('jsdom');

module.exports = function(req, res){
    var searchParam = req.query.search;
    var searchUrl = 'http://www.opensubtitles.org/en/search2/sublanguageid-tur/moviename-' + searchParam + '/sort-2/asc-0';

    request(searchUrl, function(error, response, body){
        if (error || response.statusCode != 200) {
            res.send([]);
            return;
        }

        jsdom.env(body, ['http://ajax.googleapis.com/ajax/libs/jquery/2.1.0/jquery.min.js'], function(error, window){
            var $ = window.$;
            var subtitles = [];
            _.each($('#search_results tr'), function(item){
                if ($(item).hasClass('head')) {
                    return;
                }

                if (!$(item).attr('id')) {
                    return;
                }

                var id = $(item).attr('id');
                var name = $('td a', item).eq(0).text();

                subtitles.push({
                    id: id,
                    name: name
                });
            });

            res.send(subtitles);
        });
    });
};
